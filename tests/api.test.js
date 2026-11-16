import {generateKeyPair,exportJWK,SignJWT} from "jose";
import { seal } from "../src/drive.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
let mf, db;
const uploads = [];
const driveKey = Buffer.alloc(32, 7).toString("base64");
let brokenChecksum = false, oauthIdentityToken, googlePublicKey, googlePrivateKey;
const digest = (s) => createHash("sha256").update(s).digest("hex");
async function request(
  path,
  token = "owner",
  { method = "GET", data, origin } = {},
) {
  const r = await mf.dispatchFetch("https://pos.test" + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(origin ? { Origin: origin } : {}),
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  return { status: r.status, data: await r.json() };
}
test.before(async () => {
  const pair=await generateKeyPair("RS256");googlePrivateKey=pair.privateKey;googlePublicKey={...await exportJWK(pair.publicKey),kid:"test-google",alg:"RS256",use:"sig"};
  const b = await build({
    entryPoints: ["src/worker.js"],
    bundle: true,
    format: "esm",
    write: false,
    platform: "browser",
  });
  mf = new Miniflare({
    modules: true,
    script: b.outputFiles[0].text,
    compatibilityDate: "2026-08-01",
    d1Databases: ["DB"],
    outboundService: async (req) => {
      const url = new URL(req.url);
      if (url.hostname === "oauth2.googleapis.com")
        return Response.json({ access_token: "drive-test-access", refresh_token:"refresh-secret", id_token:oauthIdentityToken, scope:"openid email https://www.googleapis.com/auth/drive.appdata" });
      if(url.pathname==='/oauth2/v3/certs') return Response.json({keys:[googlePublicKey]});
      if (
        url.hostname === "www.googleapis.com" &&
        url.pathname === "/upload/drive/v3/files"
      ) {
        assert.equal(
          req.headers.get("Authorization"),
          "Bearer drive-test-access",
        );
        const boundary = req.headers.get("Content-Type").split("boundary=")[1],
          parts = (await req.text()).split("--" + boundary);
        const meta = JSON.parse(parts[1].split("\r\n\r\n")[1].trim()),
          body = parts[2].split("\r\n\r\n").slice(1).join("\r\n\r\n").trim();
        const file = { id: "drive-file-" + (uploads.length + 1), meta, body };
        uploads.push(file);
        return Response.json({ id: file.id });
      }
      if (url.pathname === "/drive/v3/files")
        return Response.json({
          files: uploads.map((x) => ({
            id: x.id,
            name: x.meta.name,
            appProperties: x.meta.appProperties,
          })),
        });
      const file = uploads.find(
        (x) => url.pathname === "/drive/v3/files/" + x.id,
      );
      if (file) {
        if (url.searchParams.get("alt") === "media")
          return new Response(file.body);
        return Response.json({
          mimeType: "application/json",
          size: file.body.length,
          appProperties: {
            ...file.meta.appProperties,
            ...(brokenChecksum ? { sha256: "bad" } : {}),
          },
        });
      }
      return new Response("No external service expected", { status: 500 });
    },
    bindings: {
      MASTER_GOOGLE_SUB: "master",
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
      DRIVE_TOKEN_KEY: driveKey,
      APP_ORIGIN: "https://pos.test",
      ANDROID_ORIGIN: "https://localhost",
    },
  });
  db = await mf.getD1Database("DB");
  const sql = (
    await Promise.all(
      (await fs.readdir("migrations"))
        .filter((x) => x.endsWith(".sql"))
        .sort()
        .map((x) => fs.readFile("migrations/" + x, "utf8")),
    )
  ).join("\n");
  let buffer = "";
  for (const line of sql.split("\n")) {
    buffer += line + "\n";
    if (
      line.trim().endsWith(";") &&
      (!buffer.trimStart().startsWith("CREATE TRIGGER") ||
        line.trim() === "END;")
    ) {
      await db.prepare(buffer).run();
      buffer = "";
    }
  }
  for (const id of ["owner", "cashier", "outsider", "master"]) {
    await db
      .prepare("INSERT INTO users VALUES(?,?,?)")
      .bind(id, id + "@example.com", id)
      .run();
    await db
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .bind(digest(id), id, 9999999999)
      .run();
  }
  for (const id of ["a", "b"])
    await db
      .prepare("INSERT INTO shops(id,name,created_at) VALUES(?,?,?)")
      .bind(id, id, "2026-01-01")
      .run();
  await db
    .prepare(
      "INSERT INTO members VALUES('a','owner','owner'),('a','cashier','cashier'),('b','outsider','owner')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO products VALUES('p','a','Rice','r','Rice','kg',7200,6000,10000,1000,'',1)",
    )
    .run();
});
test.after(async () => {
  await mf?.dispose();
});
test("authentication and shop boundaries are enforced", async () => {
  assert.equal((await request("/api/me", "invalid")).status, 401);
  assert.equal(
    (await request("/api/shops/a/snapshot", "outsider")).status,
    403,
  );
  assert.equal((await request("/api/shops/b/snapshot", "owner")).status, 403);
  assert.equal((await request("/api/shops/a/snapshot", "cashier")).status, 200);
  assert.equal((await request("/api/admin", "owner")).status, 403);
  assert.equal((await request("/api/admin", "master")).status, 200);
});
test("cashiers cannot edit products or invite staff", async () => {
  assert.equal(
    (
      await request("/api/shops/a/products", "cashier", {
        method: "POST",
        data: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/shops/a/members", "cashier", {
        method: "POST",
        data: { email: "x@example.com" },
      })
    ).status,
    403,
  );
});
test("sales are authoritative, atomic and idempotent", async () => {
  const sale = {
    id: "sale-1",
    created_at: new Date().toISOString(),
    payment: "Cash",
    discount: 0,
    total: 7200,
    tendered: 10000,
    lines: [{ product_id: "p", qty: 1000, price: 7200 }],
  };
  assert.equal(
    (
      await request("/api/shops/a/sales", "cashier", {
        method: "POST",
        data: sale,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await request("/api/shops/a/sales", "cashier", {
        method: "POST",
        data: sale,
      })
    ).data.duplicate,
    true,
  );
  assert.equal(
    (await db.prepare("SELECT stock FROM products WHERE shop_id='a'").first())
      .stock,
    9000,
  );
  assert.equal(
    (
      await request("/api/shops/a/sales", "cashier", {
        method: "POST",
        data: {
          ...sale,
          id: "wrong-price",
          lines: [{ product_id: "p", qty: 1000, price: 1 }],
        },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("/api/shops/a/sales", "cashier", {
        method: "POST",
        data: {
          ...sale,
          id: "no-stock",
          lines: [{ product_id: "p", qty: 100000, price: 7200 }],
        },
      })
    ).status,
    409,
  );
  assert.equal((await db.prepare("SELECT count(*) n FROM sales").first()).n, 1);
});
test("optimistic stock editing rejects stale version", async () => {
  const p = {
    id: "p",
    version: 1,
    name: "Rice",
    category: "Rice",
    unit: "kg",
    price: 7200,
    cost: 6000,
    stock: 10000,
    low_stock: 1000,
  };
  assert.equal(
    (
      await request("/api/shops/a/products", "owner", {
        method: "POST",
        data: p,
      })
    ).status,
    409,
  );
});
test("suspended shops are blocked and master can reactivate", async () => {
  assert.equal(
    (
      await request("/api/shops/a/status", "master", {
        method: "POST",
        data: { active: false },
      })
    ).status,
    200,
  );
  assert.equal((await request("/api/shops/a/snapshot", "owner")).status, 403);
  assert.equal(
    (
      await request("/api/shops/a/status", "master", {
        method: "POST",
        data: { active: true },
      })
    ).status,
    200,
  );
});
test("unapproved origins are rejected", async () => {
  assert.equal(
    (await request("/api/me", "owner", { origin: "https://evil.test" })).status,
    403,
  );
});
test("invalid Google tokens cannot create a session", async () => {
  assert.equal(
    (
      await request("/api/auth/google", "", {
        method: "POST",
        data: { credential: "fake" },
      })
    ).status,
    401,
  );
});
test("device sessions need approval and can be consumed only once", async () => {
  const start = await request("/api/auth/device/start", "", { method: "POST" });
  assert.equal(start.status, 200);
  assert.equal(
    (
      await request("/api/auth/device/poll", "", {
        method: "POST",
        data: { secret: start.data.secret },
      })
    ).data.pending,
    true,
  );
  assert.equal(
    (
      await request("/api/auth/device/approve", "owner", {
        method: "POST",
        data: { code: start.data.code },
      })
    ).status,
    200,
  );
  const done = await request("/api/auth/device/poll", "", {
    method: "POST",
    data: { secret: start.data.secret },
  });
  assert.ok(done.data.token);
  assert.equal(
    (await request("/api/me", done.data.token)).data.user.id,
    "owner",
  );
  assert.equal(
    (
      await request("/api/auth/device/poll", "", {
        method: "POST",
        data: { secret: start.data.secret },
      })
    ).status,
    410,
  );
});

test("Drive access requires a shop owner and callback state is checked", async () => {
  assert.equal(
    (await request("/api/drive/status?shop=a", "cashier")).status,
    403,
  );
  assert.equal(
    (await request("/api/drive/export?shop=b", "owner")).status,
    403,
  );
  const start = await request("/api/drive/connect", "owner", {
    method: "POST",
    data: { shop_id: "a", consent: true },
  });
  assert.equal(start.status, 200);
  const authUrl = new URL(start.data.url);
  assert.equal(authUrl.searchParams.get("access_type"), "offline");
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    authUrl.searchParams.get("redirect_uri"),
    "https://pos.test/api/drive/callback",
  );
  assert.ok(authUrl.searchParams.get("scope").includes("drive.appdata"));
  assert.equal(
    (await request("/api/drive/callback?state=wrong&code=bad", "")).status,
    403,
  );
});
test('Drive callback binds the Google identity and consumes OAuth state once',async()=>{
 const tokenFor=subject=>new SignJWT({email_verified:true,email:subject+'@example.com'}).setProtectedHeader({alg:'RS256',kid:'test-google'}).setIssuer('https://accounts.google.com').setAudience('test-client').setSubject(subject).setExpirationTime('5m').sign(googlePrivateKey);
 const connect=async()=>new URL((await request('/api/drive/connect','owner',{method:'POST',data:{shop_id:'a',consent:true}})).data.url).searchParams.get('state');
 const callback=state=>mf.dispatchFetch('https://pos.test/api/drive/callback?state='+state+'&code=test-code',{redirect:'manual',headers:{Cookie:'khum_drive_state='+state}});
 oauthIdentityToken=await tokenFor('outsider');const wrong=await callback(await connect());assert.equal(wrong.status,303);assert.ok(wrong.headers.get('Location').includes('drive=failed'));assert.equal(await db.prepare("SELECT * FROM drive_connections WHERE user_id='owner'").first(),null);
 oauthIdentityToken=await tokenFor('owner');const state=await connect(),right=await callback(state);assert.equal(right.status,303);assert.ok(right.headers.get('Location').includes('drive=connected'));const c=await db.prepare("SELECT * FROM drive_connections WHERE user_id='owner'").first();assert.ok(c.refresh_token&&!c.refresh_token.includes('refresh-secret'));assert.equal((await callback(state)).status,403);
});
test("Drive backup exports full history, verifies integrity, and disconnect preserves files", async () => {
  await db
    .prepare(
      "INSERT OR REPLACE INTO drive_connections(user_id,refresh_token,connected_at) VALUES(?,?,?)",
    )
    .bind(
      "owner",
      await seal({ DRIVE_TOKEN_KEY: driveKey }, "owner", "refresh-secret"),
      new Date().toISOString(),
    )
    .run();
  await db
    .prepare("INSERT OR IGNORE INTO drive_backups(user_id,shop_id) VALUES('owner','a')")
    .run();
  // Historical receipts are distinct from the currently loaded 500-receipt UI window.
  for (let i = 0; i < 501; i++) {
    const id = "old-" + i;
    await db
      .prepare("INSERT INTO sales VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(
        id,
        "a",
        "owner",
        new Date().toISOString(),
        new Date().toISOString(),
        "Cash",
        7200,
        0,
        7200,
        7200,
      )
      .run();
    await db
      .prepare("UPDATE products SET stock=stock+1000 WHERE id=? AND shop_id=?")
      .bind("p", "a")
      .run();
    await db
      .prepare("INSERT INTO sale_lines VALUES(?,?,?,?,?,?,?)")
      .bind("a", id, "p", "Rice", 1000, 7200, 6000)
      .run();
  }
  const result = await request("/api/drive/backup", "owner", {
    method: "POST",
    data: { shop_id: "a", force: true },
  });
  assert.equal(result.status, 200);
  assert.equal(uploads.length, 1);
  const full = JSON.parse(uploads[0].body);
  assert.equal(full.sales.length, 502);
  assert.equal(full.lines.length, 502);
  assert.ok(!uploads[0].body.includes("refresh-secret"));
  assert.deepEqual(uploads[0].meta.parents, ["appDataFolder"]);
  const status = await request("/api/drive/status?shop=a");
  assert.ok(status.data.backup.last_success);
  assert.equal(status.data.backup.last_error, "");
  const downloaded = await request("/api/drive/files/" + result.data.file.id);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.data.sales.length, 502);
  brokenChecksum = true;
  assert.equal(
    (await request("/api/drive/files/" + result.data.file.id)).status,
    409,
  );
  brokenChecksum = false;
  await db
    .prepare("UPDATE drive_backups SET last_attempt=0 WHERE user_id='owner'")
    .run();
  const unchanged = await request("/api/drive/backup", "owner", {
    method: "POST",
    data: { shop_id: "a" },
  });
  assert.equal(unchanged.data.unchanged, true);
  assert.equal(uploads.length, 1);
  assert.equal(
    (
      await request("/api/drive/disconnect", "owner", {
        method: "POST",
        data: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("/api/drive/status?shop=a")).data.backup.enabled,
    0,
  );
  assert.equal(uploads.length, 1);
  assert.equal((await request("/api/drive/files")).status, 409);
});
