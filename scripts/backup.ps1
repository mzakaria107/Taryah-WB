# backup.ps1 - Daily PostgreSQL backup - PS 5.1 compatible
param()
$date = Get-Date -Format "yyyyMMdd_HHmm"
$backupDir = "C:\backups"
$backupFile = $backupDir + "\db_" + $date + ".sql"

if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }

$envFile = "C:\apps\Taryah-WB\.env"
if (Test-Path $envFile) {
    $lines = Get-Content $envFile
    foreach ($line in $lines) {
        if ($line -match "^([^#=]+)=(.*)$") {
            $k = $Matches[1].Trim()
            $v = $Matches[2].Trim()
            [System.Environment]::SetEnvironmentVariable($k, $v, "Process")
        }
    }
}

if ($env:DB_USER)     { $pgUser = $env:DB_USER }     else { $pgUser = "cbuser" }
if ($env:DB_NAME)     { $pgDb   = $env:DB_NAME }     else { $pgDb   = "customer_balance_db" }
if ($env:DB_PASSWORD) { $pgPass = $env:DB_PASSWORD } else { $pgPass = "" }
if ($env:DB_HOST)     { $pgHost = $env:DB_HOST }     else { $pgHost = "localhost" }

$env:PGPASSWORD = $pgPass
$pgDump = "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe"
& $pgDump -U $pgUser -h $pgHost $pgDb | Out-File -FilePath $backupFile -Encoding utf8

if ($LASTEXITCODE -eq 0) {
    $sz = [math]::Round((Get-Item $backupFile).Length / 1KB, 1)
    Write-Host ("Backup OK: " + $backupFile + " (" + $sz + " KB)")
} else {
    Write-Host "pg_dump failed - check credentials"
    exit 1
}

$cutoff = (Get-Date).AddDays(-7)
$old = Get-ChildItem -Path ($backupDir + "\db_*.sql") | Where-Object { $_.LastWriteTime -lt $cutoff }
foreach ($f in $old) { Remove-Item $f.FullName -Force }

Write-Host "Backups in C:\backups:"
Get-ChildItem -Path ($backupDir + "\db_*.sql") | Select-Object Name, LastWriteTime
