@echo off
echo ╔══════════════════════════════════════════════╗
echo ║     STFM Sales - Android APK Setup           ║
echo ╚══════════════════════════════════════════════╝
echo.

echo [1/4] Installing npm packages...
call npm install
if %errorlevel% neq 0 (
    echo ERROR: npm install failed. Make sure Node.js is installed.
    pause
    exit /b 1
)

echo.
echo [2/4] Adding Android platform...
call npx cap add android
if %errorlevel% neq 0 (
    echo NOTE: If android already exists, this is OK. Continuing...
)

echo.
echo [3/4] Syncing web files to Android...
call npx cap sync android
if %errorlevel% neq 0 (
    echo ERROR: cap sync failed. Check Android SDK is installed.
    pause
    exit /b 1
)

echo.
echo [4/4] Copying config files...
echo    Copying AndroidManifest.xml...
copy /Y "android-config\app\src\main\AndroidManifest.xml" "android\app\src\main\AndroidManifest.xml"

echo    Copying network_security_config.xml...
if not exist "android\app\src\main\res\xml" mkdir "android\app\src\main\res\xml"
copy /Y "android-config\app\src\main\res\xml\network_security_config.xml" "android\app\src\main\res\xml\network_security_config.xml"
copy /Y "android-config\app\src\main\res\xml\file_paths.xml" "android\app\src\main\res\xml\file_paths.xml"

echo    Copying build.gradle (for reference)...
copy /Y "android-config\app\build.gradle" "android\app\build.gradle.stfm-reference"

echo.
echo ╔══════════════════════════════════════════════╗
echo ║  ✅ Setup Complete!                          ║
echo ║                                              ║
echo ║  Next: Open Android Studio to build APK     ║
echo ║  Run: npx cap open android                  ║
echo ╚══════════════════════════════════════════════╝
echo.
echo IMPORTANT: Place your stfm-release.jks keystore file
echo in this folder before building the release APK.
echo.
pause
