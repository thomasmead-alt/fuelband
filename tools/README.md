# FuelBand native tool

Talks to a first-generation Nike+ FuelBand (`11ac:6565`) over USB using
**hidapi** (`node-hid`).

The browser can't do this job. WebHID only permits feature transfers on report
IDs the descriptor declares — here just ID 113, which won't read — and the band
never emits input-report events, so every read fails from a browser. hidapi has
no such restriction, the same way the original `libfuelband` and
`rbrune/fuelband-usb` projects worked.

The protocol, the config-block format, and the state of the imprint
investigation are documented in **[`PROTOCOL.md`](PROTOCOL.md)**.

## Run it

```sh
cd tools
npm install
node fuelband-dump.js
```

`npm install` pulls `node-hid` (prebuilt; no compiler needed on macOS/Windows).
On **Linux** you may need `libusb-1.0-0` plus a udev rule for `11ac:6565`, or
`sudo`, so the process can open the device.

## Commands

Read-only — safe to run any time:

| command | what it does |
|---|---|
| `node fuelband-dump.js` | probe both framings, then dump the desktop region |
| `--recon` | baseline: identity, status, battery, all timestamps, account region |
| `--status` | status `0xdf`, decodes the **imprinted** bit (bit 0) |
| `--read-config` | desktop config block via `0x51` |
| `--memsweep` | sweep the desktop partition for any non-`0xff` bytes |
| `--readmem <hexStart> <hexLen>` | read via `0x19` (workout sample store) |
| `--find <number>` | scan readable regions for a value shown on the band |

Write attempts — these send commands that try to change device state. None have
committed anything so far; all are recoverable with the band's hardware reset
(hold the button ~10s until RESET flashes):

| command | what it does |
|---|---|
| `--set-clock` | send `0x31` with the current time, then verify |
| `--fuzz` | sweep write framings, report which ones the band *engages* with |
| `--writetest`, `--writetest2`, `--writetest3` | write-structure searches, each verified by region read-back |
| `--fuzzwrite` | sweep opcodes looking for one that writes the region |
| `--imprint`, `--imprint2` | build and write a config blob, sweeping `imprint_state` |

## Current state

Reads all work: identity, serial, firmware, status, battery, timestamps,
account region, and the desktop config region.

Writes do not. The test band is factory-blank (32,816 bytes swept, all `0xff`;
imprinted bit = 0) and shows the "connect to USB" prompt. Setting the clock is
acknowledged but does not initialize it — imprinting needs a valid
`DesktopOptions` blob whose leading fields (`DIN`, `UDI`,
`device group config id`) are Nike account-issued values, and those servers shut
down in 2018.

See [`PROTOCOL.md` §5](PROTOCOL.md) for the write investigation, the
verification oracles, and what's left to try.
