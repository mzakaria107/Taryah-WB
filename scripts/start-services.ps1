# start-services.ps1 — PowerShell 5.1 compatible
# Run as Administrator after .env and SSL certs are ready

$ErrorActionPreference = "Continue"

Write-Host "=== Starting Taryah Dashboard Services ===" -ForegroundColor Cyan

# Verify .env
if (-not (Test-Path C:\apps\Taryah-WB\.env)) {
    Write-Error ".env not found at C:\apps\Taryah-WB\.env"
    exit 1
}

# Verify SSL certs
if (-not (Test-Path C:\certs\fullchain.pem)) {
    Write-Error "C:\certs\fullchain.pem not found — run win-acme first"
    exit 1
}
if (-not (Test-Path C:\certs\privkey.pem)) {
    Write-Error "C:\certs\privkey.pem not found — run win-acme first"
    exit 1
}

# 1. Start backend with PM2
Write-Host "[1/3] Starting backend with PM2..." -ForegroundColor Yellow
Set-Location C:\apps\Taryah-WB\backend
pm2 delete taryah-backend 2>$null
pm2 start src/index.js --name "taryah-backend" --env production --log C:\apps\Taryah-WB\logs\backend.log --merge-logs
pm2 save
Write-Host "Backend started."

# Test backend health
Start-Sleep -Seconds 4
try {
    $r = Invoke-RestMethod -Uri "http://localhost:3000/api/health" -TimeoutSec 5
    Write-Host "Backend health: $($r.status)" -ForegroundColor Green
} catch {
    Write-Warning "Backend health check failed. Check: pm2 logs taryah-backend"
}

# 2. Start nginx
Write-Host "[2/3] Starting nginx..." -ForegroundColor Yellow
$nginxDir = Get-ChildItem C:\tools\nginx-* -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
if (-not $nginxDir) {
    Write-Error "nginx not found in C:\tools"
    exit 1
}
$nginxExe = "$($nginxDir.FullName)\nginx.exe"

# Copy latest config
Copy-Item C:\apps\Taryah-WB\nginx.conf "$($nginxDir.FullName)\conf\nginx.conf" -Force

# Test config
$test = Start-Process -FilePath $nginxExe -ArgumentList "-t" -WorkingDirectory $nginxDir.FullName -Wait -PassThru -NoNewWindow
if ($test.ExitCode -ne 0) {
    Write-Error "nginx config test failed"
    exit 1
}

# Kill any old nginx
Get-Process nginx -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

# Start nginx
Start-Process -FilePath $nginxExe -WorkingDirectory $nginxDir.FullName -WindowStyle Hidden
Write-Host "nginx started."

# 3. Register nginx as Windows Service via NSSM
Write-Host "[3/3] Registering nginx as Windows Service..." -ForegroundColor Yellow
$nssmExe = (Get-Command nssm -ErrorAction SilentlyContinue)
if ($nssmExe -eq $null) {
    choco install nssm -y
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}

nssm install TaryahNginx $nginxExe 2>$null
nssm set TaryahNginx AppDirectory $nginxDir.FullName 2>$null
nssm set TaryahNginx Start SERVICE_AUTO_START 2>$null
Start-Service TaryahNginx -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "=== All services started ===" -ForegroundColor Green
pm2 status
Write-Host ""
Get-Service TaryahNginx -ErrorAction SilentlyContinue | Select-Object Name, Status
