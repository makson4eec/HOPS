param([Parameter(Mandatory=$true)][string]$RunAsUser, [string]$TaskName = 'HOPS', [string]$OneCUser = '')
. (Join-Path $PSScriptRoot 'windows-common.ps1')
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this installer from an elevated PowerShell' }
$identity = [Security.Principal.NTAccount]::new($RunAsUser)
$sid = $identity.Translate([Security.Principal.SecurityIdentifier]).Value
if ($sid -in @('S-1-5-18','S-1-5-19','S-1-5-20')) { throw 'Use a dedicated standard local user, not SYSTEM or a built-in service identity' }
if (-not (Test-Path -LiteralPath (Join-Path $HopsRoot '.next/BUILD_ID'))) { throw 'Build the production application first: npm.cmd ci; npm.cmd run build' }
New-Item -ItemType Directory -Path $HopsData -Force | Out-Null
foreach ($folder in @('incoming','outgoing/orders','orders','archive','logs','backups','runtime','accepted')) { New-Item -ItemType Directory -Path (Join-Path $HopsData $folder) -Force | Out-Null }
# Replace inherited and explicit ACLs on private roots.
function Set-PrivateFolderAcl([string]$Folder) {
    $acl = Get-Acl -LiteralPath $Folder
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleAll($rule) }
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'), [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($RunAsUser, [Security.AccessControl.FileSystemRights]::Modify, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $Folder -AclObject $acl
}
Set-PrivateFolderAcl $HopsData
foreach ($child in Get-ChildItem -LiteralPath $HopsData -Force) {
    & icacls.exe $child.FullName '/reset' '/T' '/Q'
    if ($LASTEXITCODE -ne 0) { throw 'Failed to reset private child permissions' }
}
$backupPath = Get-HopsSetting 'HOPS_BACKUP_DIR' ''
if ($backupPath) {
    if (-not [IO.Path]::IsPathRooted($backupPath)) { throw 'HOPS_BACKUP_DIR must be absolute' }
    $backupPath = [IO.Path]::GetFullPath($backupPath)
    if ($backupPath -eq [IO.Path]::GetPathRoot($backupPath) -or $backupPath -eq $HopsRoot -or $backupPath.StartsWith((Join-Path $HopsRoot 'public'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Choose a dedicated private backup folder' }
    New-Item -ItemType Directory -Path $backupPath -Force | Out-Null
    Set-PrivateFolderAcl $backupPath
}
& icacls.exe $HopsRoot '/grant' "${RunAsUser}:(OI)(CI)RX"
if ($LASTEXITCODE -ne 0) { throw 'Failed to grant application read access' }
$cache = Join-Path $HopsRoot '.next/cache'
New-Item -ItemType Directory -Path $cache -Force | Out-Null
& icacls.exe $cache '/grant' "${RunAsUser}:(OI)(CI)M"
if ($LASTEXITCODE -ne 0) { throw 'Failed to grant Next cache access' }
& icacls.exe (Join-Path $HopsRoot '.env') '/inheritance:r' '/grant:r' '*S-1-5-32-544:F' "${RunAsUser}:R"
if ($LASTEXITCODE -ne 0) { throw 'Failed to protect .env' }
if ($OneCUser) {
    & icacls.exe $HopsData '/grant' "${OneCUser}:(RX)"
    & icacls.exe (Join-Path $HopsData 'incoming') '/grant' "${OneCUser}:(OI)(CI)M"
    & icacls.exe (Join-Path $HopsData 'outgoing') '/grant' "${OneCUser}:(OI)(CI)RX"
    if ($LASTEXITCODE -ne 0) { throw 'Failed to grant 1C exchange access' }
}
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $HopsRoot 'start-hops.ps1')`"" -WorkingDirectory $HopsRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $RunAsUser -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Description 'HOPS local production server. No Windows login required.' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host 'Autostart installed. Wait 45-90 seconds; verify /api/health and reboot without logging in.'
