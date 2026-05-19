$date = Get-Date -Format "yyyyMMdd"
docker exec cb_postgres pg_dump -U $env:DB_USER customer_balance_db | Out-File "C:\backups\db_$date.sql" -Encoding utf8
Get-ChildItem C:\backups\*.sql | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item
Write-Host "Backup completed: db_$date.sql"
