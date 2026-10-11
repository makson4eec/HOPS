param([string]$TaskName = 'HOPS')
. (Join-Path $PSScriptRoot 'windows-common.ps1')
$runtime = Join-Path $HopsData 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
Set-Content -LiteralPath (Join-Path $runtime 'stop') -Value 'stop' -Encoding Ascii
$deadline = (Get-Date).AddSeconds(55)
while ((Test-Path -LiteralPath (Join-Path $runtime 'supervisor.json')) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
if (Test-Path -LiteralPath (Join-Path $runtime 'supervisor.json')) { throw 'Graceful stop timed out. Inspect logs; no unrelated processes were terminated.' }
Write-Host 'HOPS stopped. The startup task remains installed.'
