# STFM Build & Sync script
Write-Host "Building web assets..." -ForegroundColor Cyan
node build.js

if ($LASTEXITCODE -eq 0) {
    Write-Host "Syncing to Android Capacitor..." -ForegroundColor Green
    npx cap sync android
} else {
    Write-Host "Build failed!" -ForegroundColor Red
}