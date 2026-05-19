# backup.ps1 — PowerShell 5.1 compatible
# Scheduled via Windows Task Scheduler at 2:00 AM

$date       = Get-Date -Format "yyyyMMdd_HHmm"
$backupDir  = "C:\backups"
$backupFile = "$backupDir\db_$date.sql"

New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

# Load vars from .env file
$envFile = "C:\apps\Taryah-WB\.env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#=]+?)\s*=\s*(.*)\s*$') {
            [System.Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim(), "Process")
        }
    }
}

# Read with defaults (PS 5.1 compatible — no ?? operator)
if ($env:DB_USER)     { $pgUser = $env:DB_USER }     else { $pgUser = "cbuser" }
if ($env:DB_NAME)     { $pgDb   = $env:DB_NAME }     else { $pgDb   = "customer_balance_db" }
if ($env:DB_PASSWORD) { $pgPass = $env:DB_PASSWORD } else { $pgPass = "" }
if ($env:DB_HOST)     { $pgHost = $env:DB_HOST }     else { $pgHost = "localhost" }

$env:PGPASSWORD = $pgPass

$pgDump = "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe"
& $pgDump -U $pgUser -h $pgHost $pgDb | Out-File $backupFile -Encoding utf8

if ($LASTEXITCODE -eq 0) {
    $size = [math]::Round((Get-Item $backupFile).Length / 1KB, 1)
    Write-Host "Backup OK: $backupFile ($size KB)" -ForegroundColor Green
} else {
    Write-Error "pg_dump failed — check PostgreSQL service and .env credentials"
    exit 1
}

# Keep only last 7 days
Get-ChildItem "$backupDir\db_*.sql" | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item -Force

Write-Host "Backups retained:"
Get-ChildItem "$backupDir\db_*.sql" | Select-Object Name, LastWriteTime
