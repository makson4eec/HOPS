. (Join-Path $PSScriptRoot 'windows-common.ps1')
Set-Location -LiteralPath $HopsRoot
if (-not (Test-Path -LiteralPath '.env')) { throw 'Create .env from .env.example first' }
if (-not (Test-Path -LiteralPath '.next/BUILD_ID')) { throw 'Run npm.cmd ci and npm.cmd run build during installation/update' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$mutexName = 'Global\HOPS-' + ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($HopsRoot))).Replace('/', '_')
$mutex = [Threading.Mutex]::new($false, $mutexName)
$acquired = $false
try {
    try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw 'HOPS is already running' }
    & $node --env-file=.env scripts/supervisor.mjs
    if ($LASTEXITCODE -ne 0) { throw "HOPS supervisor exited: $LASTEXITCODE" }
} finally { if ($acquired) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
