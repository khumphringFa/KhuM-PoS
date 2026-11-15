import fs from "node:fs";
const config = JSON.parse(fs.readFileSync("wrangler.jsonc", "utf8"));
for (const name of [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CF_D1_DATABASE_ID",
])
  if (!process.env[name])
    throw Error(`Missing ${name}. See docs/DEPLOYMENT.md.`);
if (!/^[0-9a-f-]{36}$/i.test(process.env.CF_D1_DATABASE_ID))
  throw Error("Invalid D1 database ID");
config.d1_databases[0].database_id = process.env.CF_D1_DATABASE_ID;
for (const key of ["GOOGLE_CLIENT_ID", "MASTER_GOOGLE_SUB", "APP_ORIGIN"])
  config.vars[key] = process.env[key] || "";
fs.writeFileSync("wrangler.jsonc", JSON.stringify(config, null, 2) + "\n");
console.log(
  "Deployment configuration prepared. No credentials written to the repository.",
);
