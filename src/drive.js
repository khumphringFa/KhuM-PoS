import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  BACKUP_FORMAT,
  MAX_BACKUP_BYTES,
  validateArchive,
} from "../public/backup.js";
const schemas = new WeakMap();
async function ensureSchema(e) {
  let p = schemas.get(e.DB);
  if (!p) {
    p = e.DB.batch(
      [
        "CREATE TABLE IF NOT EXISTS drive_connections (user_id TEXT PRIMARY KEY REFERENCES users(id), refresh_token TEXT NOT NULL, connected_at TEXT NOT NULL, last_error TEXT NOT NULL DEFAULT '')",
        "CREATE TABLE IF NOT EXISTS drive_states (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), shop_id TEXT NOT NULL REFERENCES shops(id), verifier TEXT NOT NULL, expires INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS drive_backups (user_id TEXT NOT NULL REFERENCES users(id), shop_id TEXT NOT NULL REFERENCES shops(id), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), last_success TEXT, last_attempt INTEGER NOT NULL DEFAULT 0, last_file_id TEXT, content_hash TEXT, last_error TEXT NOT NULL DEFAULT '', locked_until INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,shop_id))",
        "CREATE INDEX IF NOT EXISTS drive_backups_due ON drive_backups(enabled,last_attempt)",
      ].map((sql) => e.DB.prepare(sql)),
    ).catch((error) => {
      schemas.delete(e.DB);
      throw error;
    });
    schemas.set(e.DB, p);
  }
  await p;
}
const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const KEYS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);
const now = () => Math.floor(Date.now() / 1000),
  iso = () => new Date().toISOString();
const stmt = (e, s, ...p) => e.DB.prepare(s).bind(...p);
const fail = (m, status = 400) => {
  throw Object.assign(Error(m), { status });
};
const json = (d, status = 200) =>
  Response.json(d, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
const random = () => crypto.randomUUID() + crypto.randomUUID();
const base64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unbase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const digest = async (s) =>
  base64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
export const driveConfigured = (e) =>
  !!(
    e.GOOGLE_CLIENT_ID &&
    e.GOOGLE_CLIENT_SECRET &&
    e.DRIVE_TOKEN_KEY &&
    e.APP_ORIGIN
  );
async function key(e) {
  let b;
  try {
    b = unbase64(e.DRIVE_TOKEN_KEY);
  } catch {
    fail("Drive token encryption key is invalid", 503);
  }
  if (b.length !== 32)
    fail("Drive token encryption key must contain 32 bytes", 503);
  return crypto.subtle.importKey("raw", b, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function seal(e, uid, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(uid) },
    await key(e),
    new TextEncoder().encode(value),
  );
  return base64(iv) + "." + base64(ciphertext);
}
export async function unseal(e, uid, value) {
  const [iv, ciphertext] = value.split(".");
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: unbase64(iv),
      additionalData: new TextEncoder().encode(uid),
    },
    await key(e),
    unbase64(ciphertext),
  );
  return new TextDecoder().decode(plain);
}
async function read(req) {
  const t = await req.text();
  if (t.length > 10000) fail("Request too large", 413);
  try {
    return JSON.parse(t);
  } catch {
    fail("Invalid JSON");
  }
}
async function owner(e, u, shop) {
  const s = await stmt(e, "SELECT active FROM shops WHERE id=?", shop).first();
  if (!s?.active) fail("Shop is unavailable", 403);
  const m = await stmt(
    e,
    "SELECT role FROM members WHERE shop_id=? AND user_id=?",
    shop,
    u.id,
  ).first();
  if (!u.master && m?.role !== "owner")
    fail("Only the shop owner or master administrator can manage backups", 403);
}
async function oauthFetch(e, params) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: e.GOOGLE_CLIENT_ID,
      client_secret: e.GOOGLE_CLIENT_SECRET,
      ...params,
    }),
  });
  const d = await r.json();
  if (!r.ok)
    fail(
      d.error === "invalid_grant"
        ? "Google authorization expired or was revoked. Reconnect Drive."
        : "Google authorization could not be completed.",
      502,
    );
  return d;
}
async function accessToken(e, uid) {
  const c = await stmt(
    e,
    "SELECT * FROM drive_connections WHERE user_id=?",
    uid,
  ).first();
  if (!c) fail("Connect your Google Drive first", 409);
  return (
    await oauthFetch(e, {
      grant_type: "refresh_token",
      refresh_token: await unseal(e, uid, c.refresh_token),
    })
  ).access_token;
}
async function google(token, url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...opts.headers },
  });
  if (!r.ok)
    fail(
      r.status === 401
        ? "Google authorization expired. Reconnect Drive."
        : "Google Drive request failed. Check Drive access, API enablement and available storage.",
      502,
    );
  return r;
}
export async function exportShop(e, shop) {
  const r = await e.DB.batch([
    stmt(e, "SELECT * FROM shops WHERE id=?", shop),
    stmt(e, "SELECT * FROM products WHERE shop_id=? ORDER BY id", shop),
    stmt(e, "SELECT * FROM sales WHERE shop_id=? ORDER BY id", shop),
    stmt(
      e,
      "SELECT * FROM sale_lines WHERE shop_id=? ORDER BY sale_id,product_id",
      shop,
    ),
  ]);
  if (!r[0].results[0]) fail("Shop not found", 404);
  const archive = {
    format: BACKUP_FORMAT,
    created_at: iso(),
    shop: r[0].results[0],
    products: r[1].results,
    sales: r[2].results,
    lines: r[3].results,
  };
  validateArchive(archive);
  if (
    new TextEncoder().encode(JSON.stringify(archive)).length > MAX_BACKUP_BYTES
  )
    fail(
      "Full backup exceeds the current 8 MB limit. No partial backup was written.",
      413,
    );
  return archive;
}
export async function runBackup(e, u, shop, force = false) {
  await owner(e, u, shop);
  if (!driveConfigured(e))
    fail(
      "Drive backup is not configured by the platform administrator yet",
      503,
    );
  const pref = await stmt(
    e,
    "SELECT * FROM drive_backups WHERE user_id=? AND shop_id=?",
    u.id,
    shop,
  ).first();
  if (!pref) fail("Enable backups for this shop first", 409);
  if (!force && (!pref.enabled || pref.last_attempt > now() - 900))
    return { skipped: true };
  const lease = await stmt(
    e,
    "UPDATE drive_backups SET locked_until=?,last_attempt=? WHERE user_id=? AND shop_id=? AND locked_until<?",
    now() + 180,
    now(),
    u.id,
    shop,
    now(),
  ).run();
  if (!lease.meta.changes) return { running: true };
  try {
    const archive = await exportShop(e, shop);
    const contentHash = await digest(
      JSON.stringify({
        shop: archive.shop,
        products: archive.products,
        sales: archive.sales,
        lines: archive.lines,
      }),
    );
    if (!force && pref.content_hash === contentHash) {
      await stmt(
        e,
        "UPDATE drive_backups SET last_success=?,last_error='',locked_until=0 WHERE user_id=? AND shop_id=?",
        iso(),
        u.id,
        shop,
      ).run();
      return { unchanged: true };
    }
    const payload = JSON.stringify(archive),
      checksum = await digest(payload),
      token = await accessToken(e, u.id),
      boundary = "khum_" + crypto.randomUUID();
    const metadata = {
      name: `KhuM PoS - ${archive.shop.name} - ${archive.created_at}.json`,
      parents: ["appDataFolder"],
      mimeType: "application/json",
      appProperties: { khumPos: "backup-v1", shopId: shop, sha256: checksum },
    };
    const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--\r\n`;
    const file = await (
      await google(
        token,
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime",
        {
          method: "POST",
          headers: {
            "Content-Type": `multipart/related; boundary=${boundary}`,
          },
          body: multipart,
        },
      )
    ).json();
    await stmt(
      e,
      "UPDATE drive_backups SET last_success=?,last_file_id=?,content_hash=?,last_error='',locked_until=0 WHERE user_id=? AND shop_id=?",
      iso(),
      file.id,
      contentHash,
      u.id,
      shop,
    ).run();
    return { file };
  } catch (error) {
    await stmt(
      e,
      "UPDATE drive_backups SET last_error=?,locked_until=0 WHERE user_id=? AND shop_id=?",
      String(error.message).slice(0, 300),
      u.id,
      shop,
    ).run();
    throw error;
  }
}
export async function driveCallback(req, e) {
  const url = new URL(req.url);
  if (url.pathname !== "/api/drive/callback") return null;
  if (!driveConfigured(e)) fail("Drive backup is not configured", 503);
  await ensureSchema(e);
  const state = url.searchParams.get("state") || "",
    cookie = req.headers
      .get("Cookie")
      ?.match(/(?:^|;\s*)khum_drive_state=([^;]+)/)?.[1];
  if (!state || cookie !== state)
    fail("Drive connection state did not match. Start again.", 403);
  const row = await stmt(
    e,
    "DELETE FROM drive_states WHERE hash=? AND expires>? RETURNING *",
    await digest(state),
    now(),
  ).first();
  if (!row) fail("Drive connection expired. Start again.", 403);
  const finish = (error) =>
    new Response(null, {
      status: 303,
      headers: {
        Location:
          e.APP_ORIGIN +
          "/?drive=" +
          encodeURIComponent(error || "connected") +
          "&driveShop=" +
          encodeURIComponent(row.shop_id),
        "Set-Cookie":
          "khum_drive_state=; Max-Age=0; Path=/api/drive/callback; HttpOnly; Secure; SameSite=Lax",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  if (url.searchParams.get("error")) return finish("denied");
  try {
    const token = await oauthFetch(e, {
      code: url.searchParams.get("code") || "",
      grant_type: "authorization_code",
      redirect_uri: e.APP_ORIGIN + "/api/drive/callback",
      code_verifier: row.verifier,
    });
    let p;
    try {
      p = (
        await jwtVerify(token.id_token, KEYS, {
          issuer: ["https://accounts.google.com", "accounts.google.com"],
          audience: e.GOOGLE_CLIENT_ID,
          algorithms: ["RS256"],
        })
      ).payload;
    } catch {
      fail("Google identity could not be verified", 401);
    }
    if (p.sub !== row.user_id || p.email_verified !== true)
      fail("Use the same Google account that is signed into KhuM PoS", 403);
    if (!token.scope?.split(" ").includes(SCOPE))
      fail("Drive app-data access was not granted", 403);
    const user = await stmt(
      e,
      "SELECT * FROM users WHERE id=?",
      row.user_id,
    ).first();
    user.master = user.id === e.MASTER_GOOGLE_SUB;
    await owner(e, user, row.shop_id);
    let refresh = token.refresh_token;
    if (!refresh) {
      const c = await stmt(
        e,
        "SELECT refresh_token FROM drive_connections WHERE user_id=?",
        user.id,
      ).first();
      if (c) refresh = await unseal(e, user.id, c.refresh_token);
    }
    if (!refresh)
      fail(
        "Google did not return offline access. Reconnect and approve backup access.",
        409,
      );
    await e.DB.batch([
      stmt(
        e,
        "INSERT INTO drive_connections(user_id,refresh_token,connected_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET refresh_token=excluded.refresh_token,connected_at=excluded.connected_at,last_error=''",
        user.id,
        await seal(e, user.id, refresh),
        iso(),
      ),
      stmt(
        e,
        "INSERT INTO drive_backups(user_id,shop_id) VALUES(?,?) ON CONFLICT(user_id,shop_id) DO UPDATE SET enabled=1",
        user.id,
        row.shop_id,
      ),
    ]);
    return finish();
  } catch {
    return finish("failed");
  }
}
export async function driveRoute(req, e, u) {
  const url = new URL(req.url),
    path = url.pathname,
    method = req.method;
  if (!path.startsWith("/api/drive/")) return null;
  await ensureSchema(e);
  if (path === "/api/drive/connect" && method === "POST") {
    if (!driveConfigured(e))
      fail(
        "Administrator setup required: Google client secret, Drive encryption key and OAuth callback",
        503,
      );
    const b = await read(req);
    if (b.consent !== true)
      fail("Approve automatic backup of this shop to your Google Drive");
    await owner(e, u, b.shop_id);
    const state = random(),
      verifier = random();
    await stmt(
      e,
      "INSERT INTO drive_states VALUES(?,?,?,?,?)",
      await digest(state),
      u.id,
      b.shop_id,
      verifier,
      now() + 600,
    ).run();
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({
      client_id: e.GOOGLE_CLIENT_ID,
      redirect_uri: e.APP_ORIGIN + "/api/drive/callback",
      response_type: "code",
      scope: "openid email " + SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: await digest(verifier),
      code_challenge_method: "S256",
      login_hint: u.email,
    }).toString();
    const response = json({ url: auth.toString() });
    response.headers.set(
      "Set-Cookie",
      `khum_drive_state=${state}; Max-Age=600; Path=/api/drive/callback; HttpOnly; Secure; SameSite=Lax`,
    );
    return response;
  }
  if (path === "/api/drive/export" && method === "GET") {
    const shop = url.searchParams.get("shop");
    await owner(e, u, shop);
    return json(await exportShop(e, shop));
  }
  if (path === "/api/drive/status") {
    const shop = url.searchParams.get("shop");
    await owner(e, u, shop);
    const c = await stmt(
        e,
        "SELECT connected_at,last_error FROM drive_connections WHERE user_id=?",
        u.id,
      ).first(),
      p = await stmt(
        e,
        "SELECT enabled,last_success,last_attempt,last_file_id,last_error,locked_until FROM drive_backups WHERE user_id=? AND shop_id=?",
        u.id,
        shop,
      ).first();
    return json({
      configured: driveConfigured(e),
      connected: !!c,
      connection: c,
      backup: p,
    });
  }
  if (path === "/api/drive/preferences" && method === "POST") {
    const b = await read(req);
    await owner(e, u, b.shop_id);
    if (
      !(await stmt(
        e,
        "SELECT user_id FROM drive_connections WHERE user_id=?",
        u.id,
      ).first())
    )
      fail("Connect your Drive first", 409);
    await stmt(
      e,
      "INSERT INTO drive_backups(user_id,shop_id,enabled) VALUES(?,?,?) ON CONFLICT(user_id,shop_id) DO UPDATE SET enabled=excluded.enabled",
      u.id,
      b.shop_id,
      b.enabled === true ? 1 : 0,
    ).run();
    return json({ ok: true });
  }
  if (path === "/api/drive/disconnect" && method === "POST") {
    await e.DB.batch([
      stmt(e, "DELETE FROM drive_connections WHERE user_id=?", u.id),
      stmt(e, "UPDATE drive_backups SET enabled=0 WHERE user_id=?", u.id),
    ]);
    return json({ ok: true });
  }
  if (path === "/api/drive/backup" && method === "POST") {
    const b = await read(req);
    return json(await runBackup(e, u, b.shop_id, b.force === true));
  }
  if (path === "/api/drive/files" && method === "GET") {
    const token = await accessToken(e, u.id),
      q =
        "trashed = false and appProperties has { key='khumPos' and value='backup-v1' }";
    const p = new URLSearchParams({
      spaces: "appDataFolder",
      q,
      fields: "files(id,name,createdTime,size,appProperties),nextPageToken",
      pageSize: "100",
      orderBy: "createdTime desc",
    });
    if (url.searchParams.get("pageToken"))
      p.set("pageToken", url.searchParams.get("pageToken"));
    return json(
      await (
        await google(token, "https://www.googleapis.com/drive/v3/files?" + p)
      ).json(),
    );
  }
  const m = path.match(/^\/api\/drive\/files\/([\w-]{1,200})$/);
  if (m && method === "GET") {
    const token = await accessToken(e, u.id),
      base = "https://www.googleapis.com/drive/v3/files/" + m[1];
    const metadata = await (
      await google(token, base + "?fields=id,size,mimeType,appProperties")
    ).json();
    if (
      metadata.appProperties?.khumPos !== "backup-v1" ||
      metadata.mimeType !== "application/json"
    )
      fail("This file is not a KhuM PoS backup", 403);
    if (Number(metadata.size) > MAX_BACKUP_BYTES)
      fail("Backup exceeds the current restore size limit", 413);
    const text = await (await google(token, base + "?alt=media")).text();
    if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES)
      fail("Backup too large", 413);
    if ((await digest(text)) !== metadata.appProperties.sha256)
      fail("Backup integrity check failed. No data was restored.", 409);
    let archive;
    try {
      archive = validateArchive(JSON.parse(text));
    } catch {
      fail("Backup is incomplete or invalid. No data was restored.", 409);
    }
    return json(archive);
  }
  fail("Drive endpoint not found", 404);
}
export async function scheduledBackups(e) {
  if (!driveConfigured(e)) return;
  await ensureSchema(e);
  await stmt(e, "DELETE FROM drive_states WHERE expires<?", now()).run();
  const due = (
    await stmt(
      e,
      "SELECT b.user_id,b.shop_id,u.email FROM drive_backups b JOIN drive_connections c ON c.user_id=b.user_id JOIN users u ON u.id=b.user_id JOIN shops s ON s.id=b.shop_id WHERE b.enabled=1 AND s.active=1 AND (b.user_id=? OR EXISTS(SELECT 1 FROM members m WHERE m.user_id=b.user_id AND m.shop_id=b.shop_id AND m.role='owner')) AND b.last_attempt<? AND (b.last_success IS NULL OR b.last_success<?) ORDER BY b.last_attempt LIMIT 3",
      e.MASTER_GOOGLE_SUB || "",
      now() - 900,
      new Date(Date.now() - 86400000).toISOString(),
    ).all()
  ).results;
  for (const d of due) {
    try {
      await runBackup(
        e,
        {
          id: d.user_id,
          email: d.email,
          master: d.user_id === e.MASTER_GOOGLE_SUB,
        },
        d.shop_id,
      );
    } catch (error) {
      console.warn("Drive backup did not complete for a scheduled shop");
    }
  }
}
