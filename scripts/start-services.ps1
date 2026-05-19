# start-services.ps1
# Start the backend (PM2) and nginx after .env and SSL certs are in place.
# Run as Administrator.

$ErrorActionPreference = "Continue"

Write-Host "=== Starting Taryah Dashboard Services ===" -ForegroundColor Cyan

# ── 1. Verify .env exists ─────────────────────────────────────────────
if (-not (Test-Path C:\apps\Taryah-WB\.env)) {
    Write-Error ".env file not found at C:\apps\Taryah-WB\.env — create it first!"
    exit 1
}

# ── 2. Verify SSL certs exist ─────────────────────────────────────────
if (-not (Test-Path C:\certs\fullchain.pem) -or -not (Test-Path C:\certs\privkey.pem)) {
    Write-Error "SSL certs not found in C:\certs\ — run win-acme first!"
    exit 1
}

# ── 3. Start backend with PM2 ─────────────────────────────────────────
Write-Host "[1/3] Starting backend with PM2..." -ForegroundColor Yellow
Set-Location C:\apps\Taryah-WB\backend

# Stop existing instance if any
pm2 delete taryah-backend 2>$null

pm2 start src/index.js `
    --name "taryah-backend" `
    --env production `
    --log C:\apps\Taryah-WB\logs\backend.log `
    --merge-logs `
    --restart-delay 3000 `
    --max-restarts 10

pm2 save
Write-Host "  Backend started."

# ── 4. Test backend health ────────────────────────────────────────────
Start-Sleep -Seconds 3
try {
    $health = Invoke-RestMethod -Uri "http://localhost:3000/api/health" -TimeoutSec 5
    Write-Host "  Backend health: $($health.status)" -ForegroundColor Green
} catch {
    Write-Warning "  Backend health check failed — check logs: pm2 logs taryah-backend"
}

# ── 5. Start nginx ────────────────────────────────────────────────────
Write-Host "[2/3] Starting nginx..." -ForegroundColor Yellow
$nginxDir = Get-ChildItem C:\tools\nginx-* -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -First 1

if (-not $nginxDir) {
    Write-Error "nginx not found in C:\tools — was it installed?"
    exit 1
}

$nginxExe = "$($nginxDir.FullName)\nginx.exe"

# Copy latest nginx.conf
Copy-Item C:\apps\Taryah-WB\nginx.conf "$($nginxDir.FullName)\conf\nginx.conf" -Force

# Test nginx config first
$test = Start-Process -FilePath $nginxExe `
    -ArgumentList "-t" -WorkingDirectory $nginxDir.FullName `
    -Wait -PassThru -NoNewWindow
if ($test.ExitCode -ne 0) {
    Write-Error "nginx config test failed — check $($nginxDir.FullName)\conf\nginx.conf"
    exit 1
}

# Kill any existing nginx processes
Get-Process nginx -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

# Start nginx
Start-Process -FilePath $nginxExe -WorkingDirectory $nginxDir.FullName -WindowStyle Hidden
Write-Host "  nginx started from $($nginxDir.FullName)"

# ── 6. Register nginx as a Windows Service (auto-start on reboot) ─────
Write-Host "[3/3] Registering nginx as Windows Service..." -ForegroundColor Yellow
$nssmPath = (Get-Command nssm -ErrorAction SilentlyContinue)?.Source
if (-not $nssmPath) {
    Write-Host "  Installing NSSM for Windows Service registration..."
    choco install nssm -y
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","User")
}

nssm install TaryahNginx $nginxExe 2>$null
nssm set TaryahNginx AppDirectory $nginxDir.FullName 2>$null
nssm set TaryahNginx Start SERVICE_AUTO_START 2>$null
Start-Service TaryahNginx -ErrorAction SilentlyContinue
Write-Host "  nginx registered as 'TaryahNginx' Windows Service."

# ── Summary ───────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path C:\apps\Taryah-WB\logs | Out-Null

Write-Host ""
Write-Host "=== All services started! ===" -ForegroundColor Green
Write-Host ""
Write-Host "Backend (PM2):"
pm2 status
Write-Host ""
Write-Host "nginx service:"
Get-Service TaryahNginx -ErrorAction SilentlyContinue | Select-Object Name, Status
Write-Host ""
Write-Host "Test the app:"
Write-Host "  curl.exe -I http://www.sales.taryahpoultry.com.sa   # expect 301"
Write-Host "  curl.exe -I https://www.sales.taryahpoultry.com.sa  # expect 200"
