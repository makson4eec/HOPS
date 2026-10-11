$ErrorActionPreference = 'Stop'
$HopsRoot = $PSScriptRoot
function Get-HopsSetting([string]$Name, [string]$Default) {
    $envFile = Join-Path $HopsRoot '.env'
    if (Test-Path -LiteralPath $envFile) {
        foreach ($line in Get-Content -LiteralPath $envFile) {
            if ($line -match ('^\s*' + [regex]::Escape($Name) + '\s*=\s*(.*?)\s*$')) { return $Matches[1].Trim('"', "'") }
        }
    }
    return $Default
}
$HopsData = Get-HopsSetting 'HOPS_DATA_DIR' 'C:\HOPS\data'
$HopsPort = [int](Get-HopsSetting 'PORT' '3000')
if (-not [IO.Path]::IsPathRooted($HopsData)) { throw 'HOPS_DATA_DIR must be an absolute path' }
$HopsData = [IO.Path]::GetFullPath($HopsData).TrimEnd('\')
if ($HopsData -eq [IO.Path]::GetPathRoot($HopsData).TrimEnd('\') -or $HopsData -eq $HopsRoot -or $HopsRoot.StartsWith($HopsData + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Use a dedicated private data folder, not a drive or project root' }
foreach ($forbidden in @((Join-Path $HopsRoot 'public'), (Join-Path $HopsRoot '.next'))) {
    if ($HopsData -eq $forbidden -or $HopsData.StartsWith($forbidden + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Private data path is unsafe' }
}
