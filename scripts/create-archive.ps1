param(
  [Parameter(Mandatory=$true)][string]$AppDirectory,
  [Parameter(Mandatory=$true)][string]$InstructionFile,
  [Parameter(Mandatory=$true)][string]$InstructionName,
  [Parameter(Mandatory=$true)][string]$Archive
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Root = [IO.Path]::GetFullPath($AppDirectory).TrimEnd('\')
$Prefix = [IO.Path]::GetFileName($Root) + '/'
$Stream = [IO.File]::Open($Archive, [IO.FileMode]::CreateNew)
try {
  $Zip = [IO.Compression.ZipArchive]::new($Stream, [IO.Compression.ZipArchiveMode]::Create, $true, [Text.Encoding]::UTF8)
  try {
    $Zip.CreateEntry($Prefix) | Out-Null
    foreach ($Directory in [IO.Directory]::EnumerateDirectories($Root, '*', [IO.SearchOption]::AllDirectories)) {
      $Zip.CreateEntry($Prefix + $Directory.Substring($Root.Length + 1).Replace('\', '/') + '/') | Out-Null
    }
    foreach ($File in [IO.Directory]::EnumerateFiles($Root, '*', [IO.SearchOption]::AllDirectories)) {
      $Name = $Prefix + $File.Substring($Root.Length + 1).Replace('\', '/')
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($Zip, $File, $Name, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($Zip, $InstructionFile, $InstructionName, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  } finally { $Zip.Dispose() }
} finally { $Stream.Dispose() }
