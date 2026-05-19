# deploy.ps1 — run this on the server for every update
# Usage: powershell -File C:\apps\Taryah-WB\deploy.ps1

Set-Location C:\apps\Taryah-WB
git pull origin main

# Rebuild frontend
Set-Location C:\apps\Taryah-WB\frontend
npm install
npm run build

# Update backend deps
Set-Location C:\apps\Taryah-WB\backend
npm install --omit=dev

# Restart backend via PM2
pm2 restart taryah-backend

# Reload nginx config without dropping connections
$nginx = (Get-ChildItem C:\tools\nginx-* -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1).FullName
if ($nginx) {
    Start-Process -FilePath "$nginx\nginx.exe" -ArgumentList "-s reload" -WorkingDirectory $nginx -Wait
    Write-Host "nginx reloaded from $nginx"
} else {
    Write-Warning "nginx not found in C:\tools — reload manually"
}

Write-Host ""
Write-Host "=== Deployment complete ===" -ForegroundColor Green
pm2 status
