# scripts/deploy.ps1 — run this on the server for every future update
# Usage: powershell -File C:\apps\Taryah-WB\scripts\deploy.ps1

Write-Host "=== Deploying Taryah Dashboard ===" -ForegroundColor Cyan

# ── Pull latest code ──────────────────────────────────────────────────
Set-Location C:\apps\Taryah-WB
git pull origin main

# ── Rebuild frontend ──────────────────────────────────────────────────
Write-Host "Building frontend..." -ForegroundColor Yellow
Set-Location C:\apps\Taryah-WB\frontend
npm install
npm run build

# ── Update backend deps ───────────────────────────────────────────────
Write-Host "Updating backend dependencies..." -ForegroundColor Yellow
Set-Location C:\apps\Taryah-WB\backend
npm install --omit=dev

# ── Restart backend ───────────────────────────────────────────────────
Write-Host "Restarting backend..." -ForegroundColor Yellow
pm2 restart taryah-backend
Start-Sleep -Seconds 2
pm2 status

# ── Reload nginx ─────────────────────────────────────────────────────
Write-Host "Reloading nginx..." -ForegroundColor Yellow
$nginxDir = Get-ChildItem C:\tools\nginx-* -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -First 1
if ($nginxDir) {
    # Copy updated config
    Copy-Item C:\apps\Taryah-WB\nginx.conf "$($nginxDir.FullName)\conf\nginx.conf" -Force
    Start-Process -FilePath "$($nginxDir.FullName)\nginx.exe" `
        -ArgumentList "-s reload" -WorkingDirectory $nginxDir.FullName -Wait
    Write-Host "  nginx reloaded." -ForegroundColor Green
} else {
    Write-Warning "nginx not found — reload manually"
}

Write-Host ""
Write-Host "=== Deployment complete ===" -ForegroundColor Green
