# Periph Studio

Настройка клавиатур и мышей разных производителей в одном приложении (раньше — NJ80 Studio).

## Что поддерживается

| Семейство | Устройства | Что умеет | Статус |
|---|---|---|---|
| Keydous / Royuan | NJ80-AP (3151:4003) и 61 модель yc200 из таблицы драйвера Keydous | сведения, подсветка, частота опроса, Win-lock, WASD; раскладка — только NJ80 | NJ80 проверена; остальные yc200 — по описанию |
| Keydous / Royuan, другие классы | 112 моделей yzw и др. | только опознание | запись отключена |
| Winbond 0416:B23C | KT87, KT108, Pulsar PCMK… | подсветка клавиш и логотипа | KT87 проверена |
| Sonix / DriveAll | MSI Forge GK600 TKL Wireless (0DB0:EA47), Womier SK80, Xinmeng M87 Pro, Aula F98 Pro | подсветка: 21 режим, цвет, радуга, яркость, скорость | по описанию (протокол Womier SK80) |
| Logitech HID++ | мыши через LIGHTSPEED/Unifying и по кабелю | заряд, DPI, частота опроса | PRO X Wireless проверена |
| QMK / VIA | клавиатуры с raw HID FF60 | сведения, подсветка RGB Matrix / RGB Light | по описанию протокола |

Неизвестное устройство: на вкладке «Устройства» кнопка «Отчёт…» сохраняет его USB-ID и список
HID-интерфейсов в файл (без серийных номеров). По отчёту можно найти протокол и добавить поддержку.

Все команды записи уходят в устройство только по кнопкам в интерфейсе.

## Обычный запуск

Ярлык **Periph Studio** на рабочем столе, или `dist\Periph Studio-win32-x64\Periph Studio.exe`.
Папку `Periph Studio-win32-x64` можно скопировать куда угодно — она самодостаточна.

Для Keydous/Royuan: клавиатура подключена кабелем (FN+5), Keydous Driver закрыт.
Для мышей Logitech: G HUB может перезаписывать DPI — лучше закрыть его.

## Сборка (PowerShell, из папки проекта)

    npm.cmd install
    npm.cmd run pack

`pack` собирает portable-папку в `dist\` и пересоздаёт ярлык на рабочем столе
(`node scripts\build.js --no-shortcut` — без ярлыка). Перед сборкой закройте приложение.

## Запуск из исходников

    npm.cmd run fix-electron
    npm.cmd start

`fix-electron` докачивает Electron в `node_modules\electron\dist`. Штатные распаковщики
(extract-zip) под Node 26 молча обрываются, поэтому `scripts\build.js` распаковывает zip
системным `tar.exe`.

## Устройство кода

- `hid.js` — Keydous/Royuan (feature reports, протокол YC200/RY108), `profiles/royuan.json` — модели.
- `kt87.js` — Winbond 0416:B23C (output reports, протокол из открытого разбора).
- `logitech.js` — HID++ 2.0 (long reports 0x11, через HIDAsync).
- `via.js` — QMK/VIA raw HID.
- `sonix.js` — Sonix/DriveAll (feature reports на FF13, протокол из драйвера Womier SK80, MIT).
- `tools/gen-royuan-profiles.js` — пересобрать профили из копии БД драйвера Keydous.
- `tools/kt87/` — запись и разбор USB-обмена (USBPcap) для новых протоколов.

Бэкапы раскладки NJ80: `%APPDATA%\Periph Studio\backups` (старые из `NJ80 Studio` переносятся сами).
