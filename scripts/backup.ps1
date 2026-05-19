# scripts/backup.ps1 — daily PostgreSQL backup
# Scheduled via Windows Task Scheduler at 2:00 AM

$date      = Get-Date -Format "yyyyMMdd_HHmm"
$backupDir = "C:\backups"
$backupFile = "$backupDir\db_$date.sql"

New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

# Load DB credentials from .env
$envFile = "C:\apps\Taryah-WB\.env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#=]+?)\s*=\s*(.*)\s*$') {
            [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], "Process")
        }
    }
}

$pgUser = $env:DB_USER     ?? "cbuser"
$pgDb   = $env:DB_NAME     ?? "customer_balance_db"
$pgPass = $env:DB_PASSWORD ?? ""
$pgHost = $env:DB_HOST     ?? "localhost"

$env:PGPASSWORD = $pgPass

# Run pg_dump
$pgDump = "C:\Program Files\PostgreSQL\15\bin\pg_dump.exe"
& $pgDump -U $pgUser -h $pgHost $pgDb | Out-File $backupFile -Encoding utf8

if ($LASTEXITCODE -eq 0) {
    $size = [math]::Round((Get-Item $backupFile).Length / 1KB, 1)
    Write-Host "Backup OK: $backupFile ($size KB)" -ForegroundColor Green
} else {
    Write-Error "pg_dump failed — check PostgreSQL service and credentials"
    exit 1
}

# Keep only last 7 days
Get-ChildItem "$backupDir\db_*.sql" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } |
    Remove-Item -Force

Write-Host "Old backups cleaned. Remaining:"
Get-ChildItem "$backupDir\db_*.sql" | Select-Object Name, LastWriteTime, Length
