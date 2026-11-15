import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
let mf, db;
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
    bindings: {
      MASTER_GOOGLE_SUB: "master",
      GOOGLE_CLIENT_ID: "test-client",
      ANDROID_ORIGIN: "https://localhost",
    },
  });
  db = await mf.getD1Database("DB");
  const sql = await fs.readFile("migrations/0001_initial.sql", "utf8");
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
