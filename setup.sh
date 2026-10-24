#!/bin/bash
echo "╔══════════════════════════════════════════════╗"
echo "║     STFM Sales - Android APK Setup           ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

echo "[1/4] Installing npm packages..."
npm install || { echo "ERROR: npm install failed"; exit 1; }

echo ""
echo "[2/4] Adding Android platform..."
npx cap add android 2>/dev/null || echo "NOTE: Android already exists or added."

echo ""
echo "[3/4] Syncing web files to Android..."
npx cap sync android || { echo "ERROR: cap sync failed. Check ANDROID_HOME is set."; exit 1; }

echo ""
echo "[4/4] Copying config files..."
cp android-config/app/src/main/AndroidManifest.xml android/app/src/main/AndroidManifest.xml
mkdir -p android/app/src/main/res/xml
cp android-config/app/src/main/res/xml/network_security_config.xml android/app/src/main/res/xml/
cp android-config/app/src/main/res/xml/file_paths.xml android/app/src/main/res/xml/
cp android-config/app/build.gradle android/app/build.gradle.stfm-reference

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  ✅ Setup Complete!                          ║"
echo "║                                              ║"
echo "║  Run: npx cap open android                  ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "IMPORTANT: Place stfm-release.jks in this folder"
echo "before building the release APK."
