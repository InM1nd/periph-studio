# Запись USB-обмена программы KT87 с клавиатурой (USBPcap).
# Запуск: PowerShell от имени администратора ->
#   powershell -ExecutionPolicy Bypass -File ".\tools\kt87\capture.ps1"   (из папки проекта)
# Скрипт ничего не отправляет в клавиатуру — только слушает шину и отмечает время каждого шага.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here 'captures'
New-Item -ItemType Directory -Force $out | Out-Null

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host 'Нужно запустить PowerShell от имени администратора.' -ForegroundColor Red; exit 1 }

$cmd = @("$env:ProgramFiles\USBPcap\USBPcapCMD.exe", "$env:ProgramFiles\Wireshark\extcap\USBPcapCMD.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $cmd) { Write-Host 'USBPcapCMD.exe не найден. Установите Wireshark с компонентом USBPcap и перезагрузите ПК.' -ForegroundColor Red; exit 1 }

Get-Process 'KT keyboard' -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host 'Закройте программу KT keyboard перед началом записи (запустим её на шаге 1).' -ForegroundColor Yellow; exit 1
}

# пишем со всех корневых хабов, лишнее отфильтрует разборщик
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$procs = @()
foreach ($n in 1..8) {
  $file = Join-Path $out "kt87-$stamp-hub$n.pcap"
  $p = Start-Process -FilePath $cmd -ArgumentList "-d \\.\USBPcap$n -o `"$file`" -A --inject-descriptors -s 65535" -PassThru -WindowStyle Hidden
  $procs += $p
}
Start-Sleep 2
$procs = $procs | Where-Object { -not $_.HasExited }
if (-not $procs) { Write-Host 'USBPcap не запустился ни на одном хабе (перезагрузка после установки?).' -ForegroundColor Red; exit 1 }
Write-Host "Запись идёт ($($procs.Count) хабов)." -ForegroundColor Green

$steps = @(
  'Запустите программу KT keyboard и дождитесь, пока она увидит клавиатуру',
  'Подсветка: режим «Статичный» (Static), цвет КРАСНЫЙ, применить',
  'Подсветка: тот же режим, цвет СИНИЙ, применить',
  'Подсветка: яркость на минимум, применить',
  'Подсветка: яркость на максимум, применить',
  'Подсветка: режим «Дыхание» (Breath), применить',
  'Подсветка: скорость на минимум, применить',
  'Подсветка: скорость на максимум, применить',
  'Подсветка: режим «Волна» (Wave), применить',
  'Клавиши: назначить на Caps Lock клавишу Esc, применить',
  'Клавиши: вернуть Caps Lock по умолчанию, применить',
  'Клавиши: назначить на Caps Lock «Громкость +» (мультимедиа), применить',
  'Клавиши: вернуть Caps Lock по умолчанию, применить',
  'Профиль: переключить на профиль 2',
  'Профиль: вернуть профиль 1',
  'Подсветка: верните свой обычный режим и цвет, применить'
)
$log = Join-Path $out "kt87-$stamp-steps.txt"
"$((Get-Date).ToString('o'))`t0`tначало записи" | Out-File $log -Encoding utf8
for ($i = 0; $i -lt $steps.Count; $i++) {
  Write-Host ''
  Write-Host ("Шаг {0}/{1}: {2}" -f ($i + 1), $steps.Count, $steps[$i]) -ForegroundColor Cyan
  Read-Host 'Нажмите Enter, когда СДЕЛАЕТЕ это (или введите s, чтобы пропустить)' | ForEach-Object {
    $mark = if ($_ -eq 's') { 'ПРОПУЩЕН' } else { 'сделано' }
    "$((Get-Date).ToString('o'))`t$($i + 1)`t$mark`t$($steps[$i])" | Out-File $log -Append -Encoding utf8
  }
  Start-Sleep -Milliseconds 800
}

Start-Sleep 2
$procs | ForEach-Object { try { $_.Kill() } catch {} }
Start-Sleep 1
Get-ChildItem $out -Filter "kt87-$stamp-hub*.pcap" | Where-Object Length -lt 100 | Remove-Item
Write-Host ''
Write-Host "Готово. Файлы в $out" -ForegroundColor Green
Get-ChildItem $out -Filter "kt87-$stamp*" | Select-Object Name, Length | Format-Table -AutoSize
