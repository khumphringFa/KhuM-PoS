# Android testing and release

## Testing APK

GitHub Actions → **Check and build Android** → successful run → artifact `KhuM-PoS-testing-apk`. Extract the ZIP and install `app-debug.apk` on a test phone. The bundled local workspace works without a server. Add the actual Cloudflare HTTPS address in Account for Google/cloud use.

Google sign-in opens in an external browser. Compare the displayed device code before approving it; then return to the app. Codes expire after 10 minutes and can be used once. This avoids unsupported Google login inside a WebView.

Browser print/PDF is available in the web app. The Android app can save/share an HTML receipt to open in a browser for printing. Backup and CSV export use Android's share sheet. Camera scanning is conditional on BarcodeDetector support; keyboard barcode scanners and manual entry are always available.

## Release signing

Create a separate permanent signing keystore for KhuM PoS and keep a secure backup. Do not commit the keystore or passwords. Do not reuse CricBoard's signing identity unless you deliberately want to share signing keys between apps.

Add these Actions secrets:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Base64 encoding of the binary release keystore |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Key alias |
| `ANDROID_KEY_PASSWORD` | Key password |

Run **Build signed Android APK** manually. It fails if signing inputs are missing, rather than labeling an unsigned APK as a release. Download `KhuM-PoS-signed-release` after success. This workflow does not publish to Google Play or create a GitHub release automatically.

The app ID is `com.khum.pos`. v0.1.0 uses versionCode 1 and versionName 0.1.0; increase versionCode for future releases. `scripts/android-config.mjs` applies these settings to the generated Android project.

A debug APK and a release APK have different signing identities. Android may require uninstalling a debug build before installing release; export/sync testing data before uninstalling. Production upgrades must use the same permanent release key.

Physical-device testing of camera, offline restart, export, Google device linking, keyboard scanners and printing is required before sharing with shopkeepers.

## Automatic GitHub Releases

The **Publish APKs to Releases** workflow archives successful Android build artifacts as downloadable APK assets on this repository's Releases page. It watches both the testing and signed Android workflows across branches. Testing builds are clearly marked as prereleases; signed builds are regular releases. APKs from fork repositories and unsuccessful builds are not published.

Each build has its own release/tag and artifact-specific APK filename. Existing release assets are preserved, and rerunning the publisher does not upload the same artifact twice. Release assets remain available after Actions artifacts expire.

The first publisher run backfills all available successful historical builds. You can run the publisher manually from Actions to repeat that backfill. Expired Actions artifacts that were never copied to Releases cannot be recovered by this workflow; the logs identify any skipped expired artifacts. No new signing key is created by publication.
