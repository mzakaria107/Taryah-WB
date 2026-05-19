# install-server.ps1 — Windows Server 2016, PowerShell 5.1 compatible
# Run as Administrator

$ErrorActionPreference = "Stop"

function RefreshPath {
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path","Machine")
    $userPath    = [System.Environment]::GetEnvironmentVariable("Path","User")
    $env:Path    = $machinePath + ";" + $userPath
}

Write-Host "=== Taryah Dashboard Server Setup ===" -ForegroundColor Cyan

# 1. Chocolatey
Write-Host "[1/9] Installing Chocolatey..." -ForegroundColor Yellow
Set-ExecutionPolicy Bypass -Scope Process -Force
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
RefreshPath

# 2. Git
Write-Host "[2/9] Installing Git..." -ForegroundColor Yellow
choco install git -y
RefreshPath

# 3. Node.js 20 LTS
Write-Host "[3/9] Installing Node.js 20 LTS..." -ForegroundColor Yellow
choco install nodejs-lts -y
RefreshPath

# 4. PostgreSQL 15
Write-Host "[4/9] Installing PostgreSQL 15..." -ForegroundColor Yellow
choco install postgresql15 --params '/Password:TaryahDB@Prod2024!' -y
RefreshPath
$pgBin = "C:\Program Files\PostgreSQL\15\bin"
if (Test-Path $pgBin) {
    $current = [System.Environment]::GetEnvironmentVariable("Path","Machine")
    [System.Environment]::SetEnvironmentVariable("Path", $current + ";" + $pgBin, "Machine")
    $env:Path = $env:Path + ";" + $pgBin
}

# 5. nginx
Write-Host "[5/9] Installing nginx..." -ForegroundColor Yellow
choco install nginx -y
RefreshPath

# 6. NSSM (for Windows Service registration)
Write-Host "[6/9] Installing NSSM..." -ForegroundColor Yellow
choco install nssm -y
RefreshPath

# 7. PM2
Write-Host "[7/9] Installing PM2..." -ForegroundColor Yellow
npm install -g pm2
npm install -g pm2-windows-startup
pm2-startup install

# 8. Clone repo
Write-Host "[8/9] Cloning repository..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path C:\apps | Out-Null
Set-Location C:\apps
if (Test-Path C:\apps\Taryah-WB) {
    Write-Host "Repo exists, pulling latest..."
    Set-Location C:\apps\Taryah-WB
    git pull origin main
} else {
    git clone https://github.com/mzakaria107/Taryah-WB.git
    Set-Location C:\apps\Taryah-WB
}

# 9. Install deps and build
Write-Host "[9/9] Installing dependencies and building frontend..." -ForegroundColor Yellow
Set-Location C:\apps\Taryah-WB\backend
npm install --omit=dev

Set-Location C:\apps\Taryah-WB\frontend
npm install
npm run build

New-Item -ItemType Directory -Force -Path C:\apps\Taryah-WB\backend\uploads | Out-Null
New-Item -ItemType Directory -Force -Path C:\apps\Taryah-WB\logs | Out-Null

# Create PostgreSQL user + database
Write-Host "Creating PostgreSQL database..." -ForegroundColor Yellow
$env:PGPASSWORD = "TaryahDB@Prod2024!"
& "C:\Program Files\PostgreSQL\15\bin\psql.exe" -U postgres -h localhost -c "CREATE USER cbuser WITH PASSWORD 'TaryahDB@Prod2024!';" 2>$null
& "C:\Program Files\PostgreSQL\15\bin\psql.exe" -U postgres -h localhost -c "CREATE DATABASE customer_balance_db OWNER cbuser;" 2>$null
& "C:\Program Files\PostgreSQL\15\bin\psql.exe" -U postgres -h localhost -c "GRANT ALL PRIVILEGES ON DATABASE customer_balance_db TO cbuser;" 2>$null

# Copy nginx config
$nginxDir = Get-ChildItem C:\tools\nginx-* -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
if ($nginxDir) {
    Copy-Item C:\apps\Taryah-WB\nginx.conf "$($nginxDir.FullName)\conf\nginx.conf" -Force
    Write-Host "nginx.conf copied to $($nginxDir.FullName)\conf\"
}

# Firewall
Write-Host "Configuring firewall..." -ForegroundColor Yellow
New-NetFirewallRule -DisplayName "HTTP-80"    -Direction Inbound -Protocol TCP -LocalPort 80   -Action Allow -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "HTTPS-443"  -Direction Inbound -Protocol TCP -LocalPort 443  -Action Allow -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "Block-3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Block -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "Block-5432" -Direction Inbound -Protocol TCP -LocalPort 5432 -Action Block -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "=== Installation complete ===" -ForegroundColor Green
Write-Host "NEXT: Create .env file, then run scripts\start-services.ps1" -ForegroundColor Cyan
Get-Service -Name postgresql* | Select-Object Name, Status
