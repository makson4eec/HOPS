param([string]$TaskName = 'HOPS')
& (Join-Path $PSScriptRoot 'stop-hops.ps1') -TaskName $TaskName
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host 'Autostart removed. Data and backups preserved.'
