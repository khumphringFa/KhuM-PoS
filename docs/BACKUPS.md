# KhuM PoS v0.2 · Sync, backup and recovery

Cloudflare is the primary shared database. Google Drive is an optional, separate backup destination selected by each shop owner. Google sign-in and Drive authorization are different permissions.

## Administrator activation

1. In Google Cloud project **KhuM PoS** (`khum-pos`), enable **Google Drive API**.
2. In the existing **KhuM PoS Web** OAuth client, add this exact authorized redirect URI: `https://khum-pos.manas-tripura.workers.dev/api/drive/callback`. Keep the existing JavaScript origin. In Data Access, add `https://www.googleapis.com/auth/drive.appdata` (the app's private folder; not all Drive files). The authorization request also uses Google identity scopes `openid email` to bind the connection to the signed-in account.
3. In Cloudflare → Worker **khum-pos** → Settings → Variables and Secrets, add **secret** `GOOGLE_CLIENT_SECRET` using the secret for that same Web OAuth client. Never put it in Git, the APK or a plaintext variable.
4. Add **secret** `DRIVE_TOKEN_KEY`: a random 32-byte key encoded as Base64. Generate it locally with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Keep this key stable and backed up securely. Changing it makes existing stored Drive refresh tokens unreadable until owners reconnect. Do not paste credentials into chat.
5. Deploy the Worker configuration. The code creates its three backup tables/index idempotently when first needed. `migrations/0002_drive_backups.sql` also records the schema for standard migration tooling. No existing business table is replaced.
6. Sign in to the live app as a shop owner/master, select the intended shop and open **Settings → Google Drive backup → Connect Google Drive**. Review and approve Google's consent using the same account as KhuM PoS. The app explicitly explains which business records will be copied.
7. Use **Backup now** and verify its successful timestamp. Open **Browse / restore Drive backups**, preview that snapshot, and verify the shop/product/receipt counts. If activation fails, Settings shows the error. Do not describe backups as active until a real Google snapshot succeeds.

The authenticated OAuth start uses a single-use, expiring state, an HttpOnly same-site cookie and PKCE. The callback verifies Google's signed identity token, user identity and granted scope. Refresh tokens are encrypted with AES-256-GCM and bound to their user. Tokens/client secrets are never included in business exports or sent to the frontend.

## Automatic behavior

- Offline sales stay in IndexedDB. After checkout/reconnection, the app attempts uploads with the original receipt IDs so retries do not deduct stock twice.
- While the app is visible and no sale/modal is in progress, pending transient failures retry approximately every 30 seconds. Conflict/permission failures remain visibly pending for manual review rather than looping forever. Idle cloud snapshots refresh about every 5 minutes. Manual Sync remains available.
- Expired logins can be refreshed from **Account → Reauthenticate Google** without signing out or removing pending sales.
- Once an owner enables a shop's Drive connection, a server cron checks every 15 minutes. It handles at most three due shops per invocation to keep requests bounded. A shop is due after roughly a day; at larger platform volumes this queue can take longer. The owner can use **Backup now** at any time. When an enabled connection is known to the open app, successful sync can also request a throttled backup check.
- An unchanged synchronized dataset does not create another automatic file. Its successful check time updates. **Backup now** deliberately creates a new snapshot.
- Each changed snapshot is a new file in this app's private Drive folder, with a content checksum. This implementation does not automatically delete old backup files or overwrite an older snapshot. Owners must monitor their available Google storage.
- Backups contain shop details, all products, all synchronized sales and all receipt lines, not only the latest 500 receipts shown by the sales screen. They exclude sessions, Google tokens, permission grants and platform audit records. Pending/rejected device-local sales are not in the central backup.
- Current snapshot/restore size limit is **8 MiB**; cloud runtime and service quotas also apply. Oversized or invalid exports fail visibly; no partial snapshot is reported as successful.

## Another phone or computer

Install the APK/open the web app, sign in with the same Google account and select the same cloud shop. Already synchronized stock and receipts load from Cloudflare. Before clearing or uninstalling the old app, verify pending sales are zero and take a local export. Never uninstall the only device that contains unsynchronized sales.

Google Drive consent is done in a regular browser, including on Android. If the APK opens the browser for connection, complete consent there and return to the APK. Existing browser sign-in/device pairing remains independent.

## Restore

Drive files belong to the Google account that created them. Choose **Browse / restore Drive backups**, inspect the snapshot timestamp and counts, then **Restore as a separate local copy**. The restored workspace appears in the shop selector. The original cloud shop is untouched; its stock is not deducted again, permissions are not reinstated, and historical receipts are not re-uploaded.

A full cloud JSON export downloaded earlier can also be imported through the local workspace's Restore file input. It creates a separate restored workspace. The original local JSON format still restores only into an empty local workspace. A backup with pending cloud sales must be synchronized/reconciled from its original account/device rather than converted into historical local receipts.

This is a recovery copy, not a destructive server rollback or a merge into live stock. If the central database needs disaster recovery, the platform administrator should separately keep D1 SQL exports/Cloudflare recovery facilities. Loss of both D1 and its Drive connection credentials would require reconnecting Drive before browsing those files.

## Pause/disconnect

Pausing disables automatic backup for the selected shop. Disconnect removes the platform's stored Drive refresh token and disables all that user's shop backup schedules. Existing Drive snapshots are preserved. Already running operations may complete. Owners can additionally revoke the app through their Google Account permissions page.

## Validation

Automated checks cover full export beyond 500 receipts, owner/cashier isolation, encrypted user-bound tokens, OAuth state rejection, unchanged snapshot suppression, checksum failures, disconnect behavior, and local restoration without re-upload or stock deduction. Live Google consent, cron execution against real Drive and recovery on physical Android hardware must be verified after administrator activation.
