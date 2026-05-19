# install-server.ps1
# Full one-time setup for Windows Server 2016 (native, no Docker)
# Run as Administrator in PowerShell

$ErrorActionPreference = "Stop"

Write-Host "=== Taryah Dashboard — Server Setup ===" -ForegroundColor Cyan
Write-Host "This script installs: Chocolatey, Git, Node.js 20, PostgreSQL 15, nginx, PM2"
Write-Host ""

# ── 1. Chocolatey ────────────────────────────────────────────────────
Write-Host "[1/9] Installing Chocolatey..." -ForegroundColor Yellow
Set-ExecutionPolicy Bypass -Scope Process -Force
[System.Net.ServicePointManager]::SecurityProtocol = `
    [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

# Refresh PATH in current session
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path","User")

# ── 2. Git ───────────────────────────────────────────────────────────
Write-Host "[2/9] Installing Git..." -ForegroundColor Yellow
choco install git -y
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path","User")

# ── 3. Node.js 20 LTS ───────────────────────────────────────────────
Write-Host "[3/9] Installing Node.js 20 LTS..." -ForegroundColor Yellow
choco install nodejs-lts -y
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path","User")

# ── 4. PostgreSQL 15 ─────────────────────────────────────────────────
Write-Host "[4/9] Installing PostgreSQL 15..." -ForegroundColor Yellow
choco install postgresql15 --params '/Password:TaryahDB@Prod2024!' -y
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path","User")
# Add psql to PATH explicitly
$pgBin = "C:\Program Files\PostgreSQL\15\bin"
if (Test-Path $pgBin) {
    [System.Environment]::SetEnvironmentVariable("Path",
        [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";$pgBin", "Machine")
    $env:Path += ";$pgBin"
}

# ── 5. nginx ─────────────────────────────────────────────────────────
Write-Host "[5/9] Installing nginx..." -ForegroundColor Yellow
choco install nginx -y
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path","User")

# ── 6. PM2 + Windows startup ─────────────────────────────────────────
Write-Host "[6/9] Installing PM2..." -ForegroundColor Yellow
npm install -g pm2
npm install -g pm2-windows-startup
pm2-startup install

# ── 7. Clone repo ────────────────────────────────────────────────────
Write-Host "[7/9] Cloning repository..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path C:\apps | Out-Null
Set-Location C:\apps

if (Test-Path C:\apps\Taryah-WB) {
    Write-Host "  Repo already exists — pulling latest..."
    Set-Location C:\apps\Taryah-WB
    git pull origin main
} else {
    git clone https://github.com/mzakaria107/Taryah-WB.git
    Set-Location C:\apps\Taryah-WB
}

# ── 8. Install dependencies & build frontend ─────────────────────────
Write-Host "[8/9] Installing dependencies and building frontend..." -ForegroundColor Yellow

Set-Location C:\apps\Taryah-WB\backend
npm install --omit=dev

Set-Location C:\apps\Taryah-WB\frontend
npm install
npm run build

# Create uploads directory
New-Item -ItemType Directory -Force -Path C:\apps\Taryah-WB\backend\uploads | Out-Null

# ── 9. Create PostgreSQL user + database ─────────────────────────────
Write-Host "[9/9] Setting up PostgreSQL database..." -ForegroundColor Yellow
$env:PGPASSWORD = "TaryahDB@Prod2024!"
psql -U postgres -h localhost -c "CREATE USER cbuser WITH PASSWORD 'TaryahDB@Prod2024!';" 2>$null
psql -U postgres -h localhost -c "CREATE DATABASE customer_balance_db OWNER cbuser;" 2>$null
psql -U postgres -h localhost -c "GRANT ALL PRIVILEGES ON DATABASE customer_balance_db TO cbuser;" 2>$null

# ── Copy nginx config ─────────────────────────────────────────────────
$nginxDir = Get-ChildItem C:\tools\nginx-* -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -First 1
if ($nginxDir) {
    Copy-Item C:\apps\Taryah-WB\nginx.conf "$($nginxDir.FullName)\conf\nginx.conf" -Force
    Write-Host "  nginx.conf copied to $($nginxDir.FullName)\conf\"
} else {
    Write-Warning "nginx not found in C:\tools — copy nginx.conf manually later"
}

# ── Firewall ─────────────────────────────────────────────────────────
Write-Host "Opening firewall ports 80 and 443..." -ForegroundColor Yellow
New-NetFirewallRule -DisplayName "HTTP-80"   -Direction Inbound -Protocol TCP -LocalPort 80  -Action Allow -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "HTTPS-443" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "Block-3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Block -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "Block-5432" -Direction Inbound -Protocol TCP -LocalPort 5432 -Action Block -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "=== Installation complete! ===" -ForegroundColor Green
Write-Host ""
Write-Host "NEXT STEPS:" -ForegroundColor Cyan
Write-Host "  1. Create C:\apps\Taryah-WB\.env  (copy from .env.example and fill values)"
Write-Host "  2. Get SSL cert: run scripts\install-ssl.ps1 or wacs.exe manually"
Write-Host "  3. Run: scripts\start-services.ps1"
Write-Host ""
Write-Host "PostgreSQL service status:"
Get-Service -Name postgresql* | Select-Object Name, Status
