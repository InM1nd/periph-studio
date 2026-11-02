param(
  [Parameter(Mandatory = $true)][string]$PlanFile,
  [Parameter(Mandatory = $true)][ValidateSet('Prepare', 'Apply')][string]$Mode
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$MarkerName = '.periph-studio-install.json'
$MovedOld = $false
$MovedNew = $false
$Launched = $null
$CreatedStage = $false
$Plan = $null

function Full([string]$Value) { return [IO.Path]::GetFullPath($Value).TrimEnd('\') }
function Same([string]$Left, [string]$Right) { return [string]::Equals((Full $Left), (Full $Right), [StringComparison]::OrdinalIgnoreCase) }
function Within([string]$Child, [string]$Parent) { return (Full $Child).StartsWith((Full $Parent) + '\', [StringComparison]::OrdinalIgnoreCase) }
function Read-Json([string]$File) { return ([IO.File]::ReadAllText($File, [Text.Encoding]::UTF8) | ConvertFrom-Json) }
function Hash-File([string]$File) {
  $Stream = [IO.File]::Open($File, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $Hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($Hash.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
  finally { $Stream.Dispose(); $Hash.Dispose() }
}
function Write-Json([string]$File, $Value) { [IO.File]::WriteAllText($File, ($Value | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding($false))) }
function Assert-NotLinked([string]$Target) {
  $Cursor = Full $Target
  while ($Cursor) {
    if (Test-Path -LiteralPath $Cursor) {
      if (([IO.File]::GetAttributes($Cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked paths are not supported for automatic updates.' }
    }
    $Next = [IO.Path]::GetDirectoryName($Cursor)
    if (!$Next -or $Next -eq $Cursor) { break }
    $Cursor = $Next
  }
}
function Assert-Plan {
  if ($Plan.format -ne 1 -or $Plan.appId -ne 'periph-studio' -or $Plan.token -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') { throw 'Invalid installation plan.' }
  if ($Plan.version -notmatch '^\d+\.\d+\.\d+$' -or $Plan.currentVersion -notmatch '^\d+\.\d+\.\d+$' -or $Plan.sha256 -notmatch '^[a-f0-9]{64}$' -or $Plan.exeName -cne 'Periph Studio.exe') { throw 'Invalid release metadata.' }
  if (!(Same $PlanFile (Join-Path $Plan.jobDir 'plan.json'))) { throw 'Invalid plan path.' }
  if ([IO.Path]::GetFileName($Plan.jobDir) -ne ('install-' + $Plan.token)) { throw 'Invalid job directory.' }
  $UpdatesDir = [IO.Path]::GetDirectoryName((Full $Plan.jobDir))
  if (!(Same $Plan.archive (Join-Path $UpdatesDir ('Periph-Studio-' + $Plan.version + '-Windows-x64.zip')))) { throw 'Invalid archive path.' }
  $Install = Full $Plan.installDir
  $Parent = [IO.Path]::GetDirectoryName($Install)
  if (!$Parent -or (Same $Install ([IO.Path]::GetPathRoot($Install)))) { throw 'A filesystem root cannot be updated.' }
  if ((Within $Plan.jobDir $Install) -or (Same $Plan.jobDir $Install)) { throw 'User data must be outside the application directory.' }
  foreach ($Protected in $Plan.protectedPaths) { if (Same $Install $Protected) { throw 'A protected directory cannot be updated.' } }
  foreach ($Pair in @(@('stageDir', '.periph-studio-stage-'), @('backupDir', '.periph-studio-backup-'), @('failedDir', '.periph-studio-failed-'))) {
    $Target = Full $Plan.($Pair[0])
    $Expected = Join-Path $Parent ($Pair[1] + $Plan.token)
    if (!(Same $Target $Expected) -or !(Within $Target $Parent) -or (Same $Target $Install)) { throw 'Unsafe transaction path.' }
    Assert-NotLinked $Target
  }
  Assert-NotLinked $Install
  Assert-NotLinked $Plan.jobDir
  Assert-NotLinked $Plan.archive
}
function Safe-Relative([string]$Value) {
  if (!$Value -or $Value.Contains('\') -or $Value.StartsWith('/') -or $Value.Contains(':')) { throw 'Invalid archive path.' }
  foreach ($Segment in $Value.TrimEnd('/').Split('/')) {
    if (!$Segment -or $Segment -eq '.' -or $Segment -eq '..' -or $Segment -match '[<>:"|?*\x00-\x1f]' -or $Segment -match '[. ]$' -or $Segment -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)') { throw 'Unsafe archive entry.' }
  }
  return $Value
}
function List-Tree([string]$Root) {
  $Items = New-Object 'Collections.Generic.List[object]'
  $Stack = New-Object 'Collections.Generic.Stack[string]'
  $Stack.Push((Full $Root))
  while ($Stack.Count -gt 0) {
    $Directory = $Stack.Pop()
    foreach ($Entry in [IO.Directory]::EnumerateFileSystemEntries($Directory)) {
      $Attributes = [IO.File]::GetAttributes($Entry)
      if (($Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Links inside the application directory are not supported.' }
      $Relative = $Entry.Substring((Full $Root).Length + 1).Replace('\', '/')
      $IsDirectory = ($Attributes -band [IO.FileAttributes]::Directory) -ne 0
      $Items.Add([PSCustomObject]@{ path = $Relative; full = $Entry; directory = $IsDirectory })
      if ($IsDirectory) { $Stack.Push($Entry) }
    }
  }
  return $Items.ToArray()
}
function Check-Installation([string]$Root, [string]$Version, [bool]$VerifyHashes) {
  Assert-NotLinked $Root
  $Manifest = Read-Json (Join-Path $Root $MarkerName)
  if ($Manifest.format -ne 1 -or $Manifest.appId -ne 'periph-studio' -or $Manifest.version -cne $Version -or @($Manifest.files).Count -lt 3 -or @($Manifest.files).Count -gt 10000) { throw 'Invalid application manifest.' }
  $Files = @{}
  foreach ($File in $Manifest.files) {
    $Relative = Safe-Relative $File.path
    if ($Relative -eq $MarkerName -or $Files.ContainsKey($Relative) -or $File.sha256 -notmatch '^[a-f0-9]{64}$' -or $File.size -lt 0) { throw 'Invalid file manifest.' }
    $Files[$Relative] = $File
  }
  foreach ($Required in @('Periph Studio.exe', 'Periph Studio Updater.exe', 'resources/app.asar', 'icudtl.dat')) { if (!$Files.ContainsKey($Required)) { throw 'The update is missing required application files.' } }
  $Directories = @{}
  foreach ($Directory in $Manifest.directories) { $Directories[(Safe-Relative $Directory)] = $true }
  $Seen = 0
  foreach ($Entry in @(List-Tree $Root)) {
    if ($Entry.directory) {
      if (!$Directories.ContainsKey($Entry.path)) { throw 'The application folder contains extra directories. Move them elsewhere before updating.' }
    } elseif ($Entry.path -ne $MarkerName) {
      if (!$Files.ContainsKey($Entry.path)) { throw 'The application folder contains extra files. Move them elsewhere before updating.' }
      $File = $Files[$Entry.path]
      if ((Get-Item -LiteralPath $Entry.full).Length -ne $File.size) { throw 'An application file was changed or damaged.' }
      if ($VerifyHashes -and (Hash-File $Entry.full) -ine $File.sha256) { throw 'Application file integrity check failed.' }
      $Seen++
    }
  }
  if ($Seen -ne $Files.Count) { throw 'The application folder is incomplete.' }
}
function Extract-Release {
  if (Test-Path -LiteralPath $Plan.stageDir) { throw 'The staging directory already exists.' }
  [IO.Directory]::CreateDirectory($Plan.stageDir) | Out-Null
  $script:CreatedStage = $true
  $ArchiveStream = [IO.File]::Open($Plan.archive, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $Hasher = [Security.Cryptography.SHA256]::Create()
    try { $Actual = ([BitConverter]::ToString($Hasher.ComputeHash($ArchiveStream))).Replace('-', '').ToLowerInvariant() } finally { $Hasher.Dispose() }
    if ($Actual -cne $Plan.sha256) { throw 'The downloaded archive was modified.' }
    $ArchiveStream.Position = 0
    $Zip = New-Object IO.Compression.ZipArchive($ArchiveStream, [IO.Compression.ZipArchiveMode]::Read, $true)
    try {
      if ($Zip.Entries.Count -gt 10000) { throw 'The update contains too many entries.' }
      $Seen = @{}
      [long]$Total = 0
      $Prefix = 'Periph Studio-win32-x64/'
      $Buffer = New-Object byte[] 65536
      foreach ($Entry in $Zip.Entries) {
        $Name = Safe-Relative $Entry.FullName
        if ((($Entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Links are not allowed in update archives.' }
        if ($Seen.ContainsKey($Name.TrimEnd('/'))) { throw 'Duplicate archive entry.' }
        $Seen[$Name.TrimEnd('/')] = $true
        if ($Name -ceq $Prefix) { continue }
        if (!$Name.StartsWith($Prefix, [StringComparison]::Ordinal)) {
          if (!$Name.Contains('/') -and $Name.EndsWith('.txt', [StringComparison]::OrdinalIgnoreCase)) { continue }
          throw 'Unexpected update archive layout.'
        }
        $Relative = Safe-Relative ($Name.Substring($Prefix.Length))
        $Target = [IO.Path]::GetFullPath((Join-Path $Plan.stageDir $Relative.Replace('/', '\')))
        if (!(Within $Target $Plan.stageDir)) { throw 'Archive entry escaped staging directory.' }
        if ($Name.EndsWith('/')) { [IO.Directory]::CreateDirectory($Target) | Out-Null; continue }
        $Total += $Entry.Length
        if ($Entry.Length -lt 0 -or $Total -gt 2147483648) { throw 'Expanded archive is too large.' }
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Target)) | Out-Null
        $InputStream = $Entry.Open()
        $OutputStream = [IO.File]::Open($Target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
          [long]$Written = 0
          while (($Count = $InputStream.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
            $Written += $Count
            if ($Written -gt $Entry.Length) { throw 'Invalid archive entry size.' }
            $OutputStream.Write($Buffer, 0, $Count)
          }
          if ($Written -ne $Entry.Length) { throw 'Incomplete archive entry.' }
          $OutputStream.Flush($true)
        } finally { $InputStream.Dispose(); $OutputStream.Dispose() }
      }
    } finally { $Zip.Dispose() }
  } finally { $ArchiveStream.Dispose() }
}
function Move-Retry([string]$Source, [string]$Destination) {
  Assert-Plan
  if (Test-Path -LiteralPath $Destination) { throw 'Transaction destination already exists.' }
  for ($Attempt = 0; $Attempt -lt 40; $Attempt++) {
    try { Move-Item -LiteralPath $Source -Destination $Destination -ErrorAction Stop; return }
    catch { if ($Attempt -eq 39) { throw }; Start-Sleep -Milliseconds 250 }
  }
}
function Start-App([string]$Argument) {
  $Info = New-Object Diagnostics.ProcessStartInfo
  $Info.FileName = Join-Path $Plan.installDir $Plan.exeName
  $Info.WorkingDirectory = $Plan.installDir
  $Info.Arguments = $Argument
  $Info.UseShellExecute = $false
  $Info.CreateNoWindow = $true
  # This is the interactive application, not the background installer.
  $Info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Normal
  return [Diagnostics.Process]::Start($Info)
}
function Result([string]$Status, [string]$Message) {
  Write-Json (Join-Path $Plan.jobDir 'result.json') @{ token = $Plan.token; status = $Status; message = $Message; version = $Plan.version }
}

try {
  $PlanFile = [IO.Path]::GetFullPath($PlanFile)
  $Plan = Read-Json $PlanFile
  Assert-Plan
  if ($Mode -eq 'Prepare') {
    Check-Installation $Plan.installDir $Plan.currentVersion $false
    $ParentProcess = [Diagnostics.Process]::GetProcessById([int]$Plan.parentPid)
    $ParentStart = $ParentProcess.StartTime.ToUniversalTime().Ticks.ToString()
    Extract-Release
    Check-Installation $Plan.stageDir $Plan.version $true
    Write-Json (Join-Path $Plan.jobDir 'prepared.json') @{ token = $Plan.token; version = $Plan.version; parentStart = $ParentStart }
    exit 0
  }
  $Prepared = Read-Json (Join-Path $Plan.jobDir 'prepared.json')
  if ($Prepared.token -cne $Plan.token -or $Prepared.version -cne $Plan.version) { throw 'Preparation receipt does not match.' }
  Check-Installation $Plan.stageDir $Plan.version $true
  $ParentProcess = $null
  try { $ParentProcess = [Diagnostics.Process]::GetProcessById([int]$Plan.parentPid) } catch [ArgumentException] { }
  if ($ParentProcess -and $ParentProcess.StartTime.ToUniversalTime().Ticks.ToString() -cne $Prepared.parentStart) { throw 'The application process identity changed.' }
  Write-Json (Join-Path $Plan.jobDir 'armed.json') @{ token = $Plan.token }
  if ($ParentProcess -and !$ParentProcess.WaitForExit(60000)) { throw 'The application did not close. No files were changed.' }
  if (Test-Path -LiteralPath (Join-Path $Plan.jobDir 'cancelled.json')) { throw 'Installation handoff was cancelled. No files were changed.' }
  $Commit = Read-Json (Join-Path $Plan.jobDir 'commit.json')
  if ($Commit.token -cne $Plan.token) { throw 'Installation handoff was not committed. No files were changed.' }
  Check-Installation $Plan.installDir $Plan.currentVersion $false
  Move-Retry $Plan.installDir $Plan.backupDir
  $MovedOld = $true
  Move-Retry $Plan.stageDir $Plan.installDir
  $MovedNew = $true
  $Launched = Start-App ('--periph-update-token=' + $Plan.token)
  $Deadline = [DateTime]::UtcNow.AddSeconds(35)
  $StartedFile = Join-Path $Plan.jobDir 'started.json'
  $Started = $false
  while ([DateTime]::UtcNow -lt $Deadline) {
    if (Test-Path -LiteralPath $StartedFile) {
      try {
        $Receipt = Read-Json $StartedFile
        if ($Receipt.token -ceq $Plan.token -and $Receipt.version -ceq $Plan.version -and $Receipt.pid -eq $Launched.Id -and !$Launched.HasExited) { $Started = $true; break }
      } catch { }
    }
    if ($Launched.HasExited) { break }
    Start-Sleep -Milliseconds 200
  }
  if (!$Started) { throw 'The new version did not confirm a successful startup.' }
  Result 'installed' 'Update installed successfully.'
  exit 0
} catch {
  $Failure = $_.Exception.Message
  $FailureRecord = $_
  if (!$Plan) { exit 1 }
  try {
    Assert-Plan
    [IO.File]::WriteAllText((Join-Path $Plan.jobDir 'failure.log'), ($FailureRecord | Out-String))
    if ($MovedNew -and $Launched -and !$Launched.HasExited) {
      $Launched.CloseMainWindow() | Out-Null
      if (!$Launched.WaitForExit(5000)) { $Launched.Kill(); $Launched.WaitForExit(5000) | Out-Null }
    }
    if ($MovedNew) { Move-Retry $Plan.installDir $Plan.failedDir }
    if ($MovedOld) { Move-Retry $Plan.backupDir $Plan.installDir }
    Result $(if ($MovedOld) { 'rolledBack' } else { 'failed' }) $Failure
    if ($MovedOld) { Start-App ('--periph-update-failed-token=' + $Plan.token) | Out-Null }
    if (!$MovedOld -and $CreatedStage -and $Mode -eq 'Prepare' -and (Test-Path -LiteralPath $Plan.stageDir)) {
      Assert-Plan
      # The exact token-bound sibling path was validated immediately before deletion.
      Remove-Item -LiteralPath $Plan.stageDir -Recurse -Force
    }
  } catch {
    try { Result 'recoveryRequired' ('Update failed: ' + $Failure + '; recovery failed: ' + $_.Exception.Message) } catch { }
  }
  exit 1
}
