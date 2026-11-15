# KhuM PoS

An offline-capable Android and web point of sale for groceries and mini-superstores. Forest-green product cards and a paper-style receipt, inspired by the reference reel. Prices use Bangladeshi taka; all receipt amounts are stored in integer paisa and quantities in thousandths of a unit.

## Included in v0.1.0

- Responsive counter, product/category search and keyboard barcode scanning.
- Camera scanning where the device browser supports BarcodeDetector; manual entry everywhere.
- Product inventory, kg/litre quantities, prices, costs, low-stock alerts and optional expiry blocking.
- Cash, card and mobile **payment recording**; no payment gateway or bank charges.
- Discounts, change, receipt history, CSV export and browser printing/PDF.
- IndexedDB offline workspace; cloud sales save locally before synchronization.
- Cloudflare Worker API + D1 migrations. All synced shop data lives in the platform owner's Cloudflare account.
- Google sign-in with server-verified JWTs; hashed, expiring sessions.
- Independent shop owners, invited cashiers and Master Super Admin. Shop access is checked server-side for every operation.
- Master overview, shop suspension/reactivation, access to shop records and audit log.
- Explicit shop-registration disclosure of central storage and master access.
- Android Capacitor build, external-browser device linking, backup/receipt export through Android's share sheet.
- Local JSON backup/restore into an empty local workspace; cloud snapshots are not blindly imported over shared stock.

## Quick local start

Requires Node 22+, npm, Python 3 and Java 21 for Android.

```sh
npm ci
npm run build
npm test
npm run dev
```

Open the address printed by the dev server. The local database is initialized automatically. Load sample products to try the counter. Local samples are separate from every cloud shop and are never silently uploaded.

For Google login locally, add `GOOGLE_CLIENT_ID=...` to `.dev.vars` and register `http://localhost:8787` as an authorized JavaScript origin. Use `localhost`, not the numeric IP, for Google testing. Do not commit `.dev.vars`.

## Cloudflare and Google setup

See [the deployment guide](docs/DEPLOYMENT.md). A single Worker deploys the frontend and API together, with a free `workers.dev` address. This avoids maintaining a separate Pages/API origin. No purchased domain is needed. Free-tier resource limits still apply.

**This repository does not itself create a Cloudflare database or Google OAuth client.** These need your account-specific setup. Do not treat a passing local test as a live deployment.

## Android

Every branch push runs checks and builds a **testing APK** in GitHub Actions. Download `KhuM-PoS-testing-apk` from the successful workflow. It is a debug build for testing, not your permanent release identity.

```sh
npm run android:prepare
cd android
./gradlew assembleDebug
```

On Windows use `gradlew.bat assembleDebug`. Android source is generated reproducibly from the pinned dependencies and `scripts/android-config.mjs`; it is intentionally ignored in Git. For signed release builds and preserving the signing key, see [the Android guide](docs/ANDROID.md).

The APK contains the UI assets so the local counter can start offline. For cloud access, enter your deployed HTTPS app origin in Account, open Google login in the external browser, and approve only the code displayed in your own app.

## Offline consistency

Each sale has a UUID idempotency key. D1 commits the sale header and stock-deducting lines in one atomic batch. Database constraints and a trigger prevent overselling, expired stock and conflicting prices. Repeated uploads return the existing receipt without a second stock deduction.

Different devices can sell cached stock while offline, so overselling cannot be ruled out until synchronization. A conflicting sale stays pending with an error; it is **never silently discarded, repriced, or counted twice**. The operator must reconcile it before using that workspace normally. Pending sales block product edits and snapshot replacement. Keep the original device and export a backup until reconciled. Automatic conflict resolution/voiding is not in v0.1.0.

Each product currently represents one stock/expiry record. Use separate products for separate expiry batches. Full batch allocation is planned.

## Data access and limits

Shop owners see their own shop; cashiers can sell and view its products/receipts, while only owners/master can change inventory and staff access. Master identity is set using the verified Google `sub` claim in server configuration, never a client-side flag or a guessed email address.

Device-local data is accessible to whoever can unlock that device/browser profile. Sign-out removes the session and switches to the local workspace; it preserves the account's cached records for later sign-in. Use dedicated, locked devices for shops. Suspension/revocation blocks the API immediately but cannot remotely erase already cached offline records.

The cloud sales screen shows the latest 500 receipts; all receipts remain in D1. CSV export covers the currently loaded history. Automated Drive backups, a full archival export, supplier purchasing, customer credit/dues, refunds, profit reports, Bengali translation, product photos and Bluetooth printer support are **not implemented yet**.

## Verification

`npm test` runs financial/cart unit tests, real Worker/D1 API integration tests with Miniflare, and SQLite migration/atomicity tests. `npm run check` checks JavaScript syntax. CI also bundles the Worker and builds Android. Google consent, a real Cloudflare deployment and installation/printing on a physical phone still need account/device validation.
