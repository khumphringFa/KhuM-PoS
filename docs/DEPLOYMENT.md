# Deploy KhuM PoS into your Cloudflare account

The frontend and API deploy together as **one Cloudflare Worker with static assets**, backed by **your D1 database**. Every shop's synced records are central; membership checks isolate shops in the API. No purchased domain or separate hosting subscription is required. Cloudflare resource quotas still apply.

## 1. Create D1

In your Cloudflare account, create a D1 database named `khum-pos`. Copy its database UUID. Alternatively, after `npx wrangler login`, run:

```sh
npx wrangler d1 create khum-pos
```

Put the returned UUID in `wrangler.jsonc` as `d1_databases[0].database_id`. Never replace an existing production database just to redeploy the app.

## 2. Deploy once to get your address

```sh
npm ci
npm run build
npm run db:remote
npm run deploy
```

Copy the exact `https://...workers.dev` address printed by Wrangler. This first deployment can run local-only mode before Google is configured. Do not use a guessed provider address.

## 3. Create Google sign-in client

In Google Cloud Authentication Platform, create a Web application OAuth client called `KhuM PoS`. Configure branding, audience and support contact. Add your exact Cloudflare origin as an **Authorized JavaScript origin**. No client secret is needed by this GIS ID-token flow; do not put one in the frontend. During Google testing mode, add the owner/cashier Google accounts as test users where required by your project's audience settings.

Set `GOOGLE_CLIENT_ID` in `wrangler.jsonc` to that client ID, set `APP_ORIGIN` to the exact HTTPS origin, and redeploy. `ANDROID_ORIGIN` remains `https://localhost` for the bundled Capacitor app. Do not add `*` to allowed origins.

Sign in on the deployed web app. In Account, copy your **Google subject ID**. Set `MASTER_GOOGLE_SUB` to this ID and redeploy. Sign in/reload again: Platform appears for that verified identity only. Do not use your email in place of the subject ID. Other shopkeepers cannot claim master by registering first.

## 4. Optional GitHub deployment workflow

Add these repository Actions secrets:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | A narrowly scoped token for Worker scripts and D1 editing in your account |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |

Add these Actions variables:

| Variable | Value |
| --- | --- |
| `CF_D1_DATABASE_ID` | The D1 UUID from step 1 |
| `GOOGLE_CLIENT_ID` | Your Google Web OAuth client ID |
| `MASTER_GOOGLE_SUB` | Your verified Google subject ID |
| `APP_ORIGIN` | Your exact deployed HTTPS origin |

Run **Deploy to my Cloudflare** from Actions on the branch you want to deploy. The workflow validates code, applies outstanding D1 migrations, and deploys. Tokens stay in the Actions secret store. Do not paste tokens in commits, issues or chat.

For Cloudflare Git integration instead, use build command `npm ci && npm run build`, deploy command `npx wrangler deploy`, and the same D1 binding and configuration. Apply migrations explicitly before the first live launch. This project is a Worker deployment, not a static-only Pages upload.

## 5. Check real accounts before sharing

1. Sign in as master, create a test shop and add products.
2. Register a second Google owner and create a separate shop. Confirm neither owner can access the other's shop.
3. Invite a cashier by Google email. Check selling works and stock editing is blocked.
4. Sell offline on one device, reconnect and check stock/receipt sync.
5. Repeat a sync, confirming no duplicate receipt or second stock deduction.
6. Try a simultaneous/low-stock conflict; verify it remains visibly pending.
7. Review both shops from the master Platform screen.
8. Take a D1 backup/export before using real stock. For a full central SQL export run `npx wrangler d1 export DB --remote --output khum-pos-backup.sql`; store the export privately.

Google Drive backups require the separate administrator setup and each owner’s Drive consent described in [BACKUPS.md](BACKUPS.md). Google login alone does **not** grant Drive access. Full cloud JSON exports and D1 exports remain available independently. Keep files with business records private.

## References

- https://developers.cloudflare.com/workers/static-assets/
- https://developers.cloudflare.com/d1/
- https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
