# STFM → APK Build Guide
## Sairah Trading Sales & Distribution Management System

---

## WHAT YOU NEED ON YOUR PC

| Tool | Download |
|------|----------|
| Node.js 18+ | https://nodejs.org |
| Android Studio | https://developer.android.com/studio |
| Java JDK 17 | bundled with Android Studio |
| Git (optional) | https://git-scm.com |

---

## STEP 1 — Create project folder

```
mkdir stfm-apk
cd stfm-apk
```

Copy these files into the folder:
- `package.json`
- `capacitor.config.json`
- `google-services.json`  ← See Step 2 first!

---

## STEP 2 — Get google-services.json from Firebase Console

⚠️  The included google-services.json has a PLACEHOLDER Android App ID.
You must register the Android app in Firebase:

1. Go to https://console.firebase.google.com
2. Open project: **stfm-sales**
3. Click ⚙️ Project Settings → **Add app** → Android
4. Package name: `com.sairahtrading.stfm`
5. App nickname: `STFM Android`
6. Click **Register app**
7. Download **google-services.json**
8. Replace the included file with the downloaded one

---

## STEP 3 — Install dependencies

```bash
npm install
```

---

## STEP 4 — Build the web assets into www/

The APK bundles the app code (it does not load the website). Build it:

```bash
npm run build
```

After this first install, code changes reach phones **over the air**: every
deploy publishes a package at https://stfm-sales.web.app/ota/ and the app
downloads it in the background, applying it on the next start. Rebuild the
APK only for native changes (new Capacitor plugin, permission or Android
code) — and when you do, raise `versionCode` in `android/app/build.gradle`
and `stfm.otaMinNativeBuild` in `package.json` to the same number so older
APKs are told to install the new one. Put the APK's download link in
`stfm.apkUrl` to show a Download button.

---

## STEP 5 — Add Android platform

```bash
npx cap add android
```

This creates the `android/` folder with the full Android project.

---

## STEP 6 — Copy google-services.json

```bash
cp google-services.json android/app/google-services.json
```

---

## STEP 7 — Add permissions to AndroidManifest.xml

Open: `android/app/src/main/AndroidManifest.xml`

Add these lines INSIDE the `<manifest>` tag (before `<application>`):

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
<uses-permission android:name="android.permission.VIBRATE" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
```

---

## STEP 8 — Sync Capacitor

```bash
npx cap sync android
```

---

## STEP 9 — Open in Android Studio

```bash
npx cap open android
```

Android Studio will open. Wait for Gradle to sync (first time takes 5-10 mins).

---

## STEP 10 — Build the APK

### Option A — Debug APK (for testing, no signing needed)
In Android Studio:
```
Build → Build Bundle(s) / APK(s) → Build APK(s)
```
APK location: `android/app/build/outputs/apk/debug/app-debug.apk`

### Option B — Release APK (for distribution)

1. Generate a keystore (do this ONCE, keep it safe forever!):
```bash
keytool -genkey -v -keystore stfm-release.keystore \
  -alias stfm -keyalg RSA -keysize 2048 -validity 10000
```

2. In Android Studio:
```
Build → Generate Signed Bundle / APK → APK
```
- Key store path: select `stfm-release.keystore`
- Fill in alias: `stfm` and your passwords
- Build variant: **release**

APK location: `android/app/build/outputs/apk/release/app-release.apk`

---

## STEP 11 — Install on phone

### Via USB:
```bash
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

### Via file:
- Copy the .apk to your phone
- Enable "Install from unknown sources" in phone Settings
- Open the .apk file to install

---

## APP DETAILS

| Field | Value |
|-------|-------|
| App ID | com.sairahtrading.stfm |
| App Name | STFM |
| Version | 1.0.0 |
| Min Android | 7.0 (API 24) |
| Target Android | 14 (API 34) |
| Firebase Project | stfm-sales |
| Live URL | https://stfm-sales.web.app |

---

## HOW THE APK WORKS

The APK uses **Capacitor server mode** — it loads your live website
(https://stfm-sales.web.app) inside a native Android WebView shell.

✅ Benefits:
- No need to rebuild APK when you update the web app
- Push notifications work natively via FCM
- Camera, GPS, share all use native Android APIs
- Works offline with your existing service worker
- App icon, splash screen, status bar all native

---

## TROUBLESHOOTING

**Gradle sync fails**
→ File → Invalidate Caches → Restart

**google-services.json error**
→ Make sure you downloaded it after registering the Android app in Firebase Console

**Camera not working**
→ Confirm permissions are in AndroidManifest.xml

**App shows blank screen**
→ Check internet connection. The app loads from stfm-sales.web.app

**Push notifications not working**
→ Make sure google-services.json is the correct one from Firebase Console
→ Go to Firebase Console → Project Settings → Cloud Messaging → enable FCM

---

## OPTIONAL: Custom App Icon

Replace these files in `android/app/src/main/res/`:
- `mipmap-hdpi/ic_launcher.png` (72×72)
- `mipmap-xhdpi/ic_launcher.png` (96×96)
- `mipmap-xxhdpi/ic_launcher.png` (144×144)
- `mipmap-xxxhdpi/ic_launcher.png` (192×192)

Use your STFM green logo on dark background (#0f172a).

---

*Generated for STFM — Sairah Trading Sdn Bhd*

---

## Building the APK on GitHub (no Android Studio needed)

`.github/workflows/android-apk.yml` builds the APK on GitHub:

- **Every merge to `main`** (and every PR that touches the app) builds an APK.
  Download it from **GitHub → Actions → Android APK → the run → Artifacts →
  `stfm-sales-apk`**. You can also start a build by hand: **Actions → Android
  APK → Run workflow**.
- **Without signing secrets** it builds `stfm-sales-debug.apk` — fine for
  testing, but a debug APK cannot replace a release-signed app already on a
  phone (Android asks to uninstall first).
- **With signing secrets** it builds a signed `stfm-sales.apk`, and merges to
  `main` also publish it as a **GitHub Release**. Staff can then always get
  the latest app from
  `https://github.com/xtremrakib007/sts/releases/latest/download/stfm-sales.apk`
  (put this link in `package.json` → `stfm.apkUrl` so the in-app "install
  the new app" banner shows a Download button). The repository is public,
  so anyone with the link can download the APK.

### One-time signing setup

Use the **same keystore** that signed the APK your staff already have, or
Android will refuse to update the app. If you have never signed a release,
create one (keep the file and passwords safe — losing them means staff must
reinstall the app):

```bash
keytool -genkeypair -v -keystore stfm-release.keystore -alias stfm -keyalg RSA -keysize 2048 -validity 10000
```

Convert the keystore to text (Windows Command Prompt):

```bash
certutil -encodehex -f stfm-release.keystore stfm-release.b64 0x40000001
```

Then in **GitHub → the repository → Settings → Secrets and variables →
Actions → New repository secret**, add:

| Secret | Value |
|---|---|
| `STFM_KEYSTORE_BASE64` | the whole contents of `stfm-release.b64` |
| `STFM_KEYSTORE_PASSWORD` | keystore password |
| `STFM_KEY_ALIAS` | key alias (e.g. `stfm`) |
| `STFM_KEY_PASSWORD` | key password |

Never commit the keystore or the `.b64` file to the repository.

---

## Automatic backend deploys (functions, rules, indexes)

Merging to `main` deploys Hosting (`firebase-hosting-merge.yml`) and, when
`functions/`, `firestore.rules`, `firestore.indexes.json` or `firebase.json`
changed, also Cloud Functions, Firestore rules and indexes
(`firebase-backend-deploy.yml`). You can also run it any time from
**Actions → Deploy Firebase backend on merge → Run workflow**.

It uses the existing `FIREBASE_SERVICE_ACCOUNT_STFM_SALES` secret. That
service account was created for Hosting only, so give it these roles once:

1. Open the secret's account: Google Cloud console → project **stfm-sales**
   → **IAM & Admin → IAM**. Find the account named like
   `github-action-…@stfm-sales.iam.gserviceaccount.com`.
2. Click the pencil (Edit principal) → **Add another role**, and add:
   - Cloud Functions Admin
   - Service Account User
   - Cloud Build Editor
   - Artifact Registry Administrator
   - Firebase Rules Admin
   - Cloud Datastore Index Admin
   - Service Usage Consumer
3. Save, then re-run the workflow from the Actions tab.

If a deploy would delete a function that is live but no longer in the code,
the workflow stops instead of deleting it; deploy that change by hand with
`firebase deploy --only functions` and answer the prompt.
