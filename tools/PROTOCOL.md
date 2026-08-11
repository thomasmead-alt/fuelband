# FuelBand USB protocol & imprint investigation

Reverse-engineered from `FuelBandPlugin.dll` (extracted from the Nike+ Connect
installer with 7-Zip; it's an NSIS package of native DLLs) and verified against
a physical first-generation Nike+ FuelBand.

The DLL retains its original C++ source filenames and log format strings
(`FuelBandCommands.cc`, `DesktopOptions.cc`, `UsbDeviceWin.cc`), which is what
made the command table and blob format recoverable.

**Status:** all *read* paths are solved and working. The *write* path is not.
See [Current approach](#current-approach-the-write-problem).

---

## 1. Device & transport

| | |
|---|---|
| Device | Nike+ FuelBand, 1st gen (not SE) |
| USB ID | `11ac:6565` |
| Test unit serial | `20M9FC5V01660`, firmware `46 0c 02 61 4f 58 3d` |

### HID report descriptor (read off the real device)

```
collection 0  usagePage:65280 usage:1
  feature: id 113 (7B)
  input:   id 4 (63B), id 3 (31B), id 2 (15B), id 1 (7B)
  output:  id 12 (63B), id 11 (31B), id 10 (15B), id 9 (7B)
```

Reports are **size-bucketed**: pick the smallest bucket that fits the body.

| payload | output id | input id |
|---|---|---|
| 7B | 9 | 1 |
| 15B | 10 | 2 |
| 31B | 11 | 3 |
| 63B | 12 | 4 |

### WebHID cannot drive this device

WebHID only permits feature transfers on report IDs the descriptor *declares*
(here: only 113, which itself won't read), and the band never emits input-report
events. Every read path fails from a browser. hidapi (`node-hid`) has no such
restriction — hence `tools/fuelband-dump.js`. This is a browser security limit,
not a device limitation.

### Two working framings

Both are `SET_REPORT`/`GET_REPORT` (feature) transfers in practice:

- **data family** — write `[outId, len, opcode, …args]`, read reply on feature ID 4.
  Used by: account (`0x43 0x19`), memory read (`0xbb 50 37 36`), desktop read (`0x51`).
- **system family** — write `[0x01, len+1, 0x07, opcode, …args]`, read reply on feature ID 1.
  Used by: version (`0x08`), serial (`0xe1`), status (`0xdf`).

The Nike app itself sends commands as **output reports**
(`HidD_SetOutputReport`, report type 2 — confirmed in the DLL's HID layer) and
reads with `HidD_GetFeature`. `device.write()` in node-hid does the former.
In practice feature-writes work for reads too; neither form makes writes commit.

### Reading a response

Replies are `[01, len, opcode, …]`. **`len` is the tell:**

| reply | meaning |
|---|---|
| `01 01 <op>` | echo — the band ignored the command |
| `len > 1` (e.g. `01 3d …`) | engaged — the band processed it |
| `0x3d` | full 61-byte chunk (more data follows) |

Multi-byte integers in payloads are **big-endian**.

---

## 2. Command opcodes

From the `FuelBandCommands.cc` registration table (each entry pairs a
completion handler with its opcode byte). Calibrated against two independently
known values: `0x13` battery and `0x60` protocol version.

| opcode | command | | opcode | command |
|---|---|---|---|---|
| `0x08` | version | | `0x37` | display loop |
| `0xe1` | serial | | `0x38` | display orientation |
| `0xe0` | model | | `0x39` | display goal options |
| `0xe2` | hw revision | | `0x3a` | gender |
| `0xdf` | status | | `0x3b` | display format |
| `0x13` | battery | | `0x40` | timestamp |
| `0x60` | protocol version | | `0x42` | (display/timestamp) |
| `0x0a` | network version | | `0x1a` | goal (get/set) |
| `0x31` | **time (get/set clock)** | | `0x25` | fuel (get/set) |
| `0x32` | 24-hour mode | | `0x51` | **get desktop data** |
| `0x33` | metric units | | `0x52` | **set desktop data** |
| `0x34` | weight | | `0x19` | read memory int (sample store) |
| `0x35` | height | | `0xbb` | memory read (region-selected) |
| `0x36` | age | | `0x17` | sample query |

Also present in the app's `<commands>` XML but not opcode-mapped here: `save`
("save all programmable parameters to flash"), `reset`, `restoreDefaults`,
`bootblock`, `eeprom-read/erase/query`, `latchup`, `network-*`.

### Region selector

`0x51`/`0x52`/`0xbb` take a **3-byte region address** immediately after the
opcode. The desktop-data region is `50 37 36` (ASCII "P76"). Without it the
band echoes; with it, it engages. Then a 3-byte offset:

```
0x51 50 37 36 <off2> <off1> <off0>     → read desktop region at offset
reply: 01 3d 51 01 <off3> <data …>
```

### Set clock (`0x31`)

From `doTime`:

```
31 <time: 4B BE unix> <gmtOffset: 4B BE seconds> <dstOffsetMinutes: 1B>
```

The band **acks** this opcode but the clock does not visibly take, and it does
not initialize the device — see §4.

---

## 3. Config block (`DesktopOptions`)

Read via `0x51`, written via `0x52`. Parser at `0x100331F0`, serializer at
`0x10032c20`.

```
[4-byte header] [payload …] [2-byte CRC, big-endian]
```

- Minimum total length 6; the 4-byte header is **not** covered by the CRC.
- CRC covers the payload only.

### Payload layout

Three fixed 48-byte identifier fields, then TLV-encoded options:

| offset | field | note |
|---|---|---|
| 0 | `DIN` | 48B, Nike-issued |
| 48 | `UDI` | 48B, Nike-issued |
| 96 | `device group config id` | 48B, Nike-issued |
| 144+ | TLV options | see below |

TLV encoding (helpers at `0x10032ba0` tag, `0x10032b10` u32, `0x100328b0` string):

```
tag(2B BE)  len(1B)  value(len bytes, BE for integers)
```

Confirmed tags: `0x0001` metric weight, `0x0002` metric height,
`0x000b` **imprint_state** (u32), `0x0005` email.
Also serialized (tag numbers less certain): birthdate, screen name, first name,
band name, profile update date, clock auto set.

### CRC-16/XMODEM

Poly `0x1021`, init `0x0000`, MSB-first, no reflection, no final XOR. Table at
`0x1005c700`; update is `crc = (crc<<8) ^ table[(crc>>8) ^ byte]`. Verified
against the canonical check value (`"123456789"` → `0x31c3`).

```js
function crc16xmodem(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= (b << 8);
    for (let i = 0; i < 8; i++)
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc & 0xffff;
}
```

---

## 4. State of the test unit

The band displays a "connect to USB" prompt and will not track fuel. This is the
**un-imprinted / never-provisioned** state — the app's own log string for it is
`Desktop data Uninitialized length, assuming new device.`

Confirmed by reads:

| check | result |
|---|---|
| status `0xdf` | `80 cf 3c 66 07 ff 0f 00` → **imprinted bit = 0** |
| desktop region | `ff` at every offset |
| memory sweep | 32,816 bytes swept, **zero** non-`0xff` bytes |

The second band is also new-in-box, so there is no provisioned unit to copy a
valid blob from.

### Verification oracles (all readable)

These are what make write attempts testable rather than blind:

1. **imprinted bit** — `0xdf` status, bit 0 of byte 0. `0` = not imprinted.
2. **region read-back** — `0x51 50 37 36 + off` returns the region contents, so
   a committed write is directly visible.
3. **engage vs echo** — reply `len > 1` means the band processed the command.

---

## 5. Current approach: the write problem

Every read works. **No write has ever committed.** Attempts so far:

| # | attempt | result |
|---|---|---|
| 1 | `0x31` set clock, feature-write | acked, no effect |
| 2 | `0x31` set clock, output-report, both framings | acked, no effect |
| 3 | `0x51` chunked `[flag, off3, 83 a2, data]` (app's structure) | echo `01 01 51` |
| 4 | full 161B blob, 4 chunks, same structure | echo; region stays `ff` |
| 5 | 8 structures with `50 37 36` as address + `83 a2` marker | **engage — but interpreted as a read**; region stays `ff` |
| 6 | opcode sweep `0x50–0x5f`, `0xb0–0xbf` + region selector + test pattern | *in progress* (`--fuzzwrite`) |

The finding from #5 is the important one: with the region selector present, the
band treats the bytes after it as a **read address** regardless of what follows,
and returns that location. `0x51`/`0x52` + `50 37 36` behave as read-only.

Two hypotheses remain:

- **A different opcode writes the region.** Memory-write commands are usually a
  sibling of the read op — hence the sweep in #6, using region read-back to
  detect a change. Ranges are restricted to `0x50–0x5f` / `0xb0–0xbf` to avoid
  `reset`, `restoreDefaults`, `eeprom-erase`, `latchup` and `bootblock`.
- **The write is a stateful transaction.** The app's transfer function
  (`0x100386f0`) maintains transfer state on the device object (region address
  `0x503736`, progress counters, a "more" flag) and streams CRC-validated chunks
  that the firmware buffers and only commits on a complete, valid blob. Driven
  command-at-a-time from outside, no partial write ever commits — which matches
  everything observed.

The write path also can't be debugged directly: write acknowledgements appear to
come back on `HidD_GetInputReport`, which node-hid cannot poll on this device.
So the only feedback is the coarse oracles in §4.

---

## 6. Root cause of the imprint problem

Even with a working write primitive, imprinting is **provisioning, not
configuration**. The blob's first three fields — `DIN`, `UDI`,
`device group config id` — plus `email`, `birthdate`, `screen name`,
`profile update date` and `imprint_state` are Nike **account-issued** values,
handed to the band during first-time setup through a Nike+ account. Nike shut
down the Nike+ services and Nike+ Connect on **30 April 2018**.

So a factory-blank band cannot be provisioned offline unless the firmware
accepts fabricated identifiers — which is unknown and untestable without either
the firmware or a capture of a real session.

---

## 7. Ruled out

- **Sample store (`0x19`)** — reads the workout sample store (its address comes
  from a `sample.lso` property), not arbitrary memory. Empty on a blank band.
- **Firmware read over USB** — no command exposes a raw flash/code read. `0xf2`
  (`device.firmware.image`) goes through the same chunked-transfer path and is
  an upgrade-staging path, not a readback.
- **Copying a valid blob from a second band** — the spare is also new-in-box.
- **FuelBand SE route** — different device (BLE, keyless auth, settings
  `FUEL=48 / CALORIES=49 / STEPS=50`); irrelevant to this hardware.

## 8. Remaining paths

1. **USB capture of Nike+ Connect** (Wireshark + USBPcap on Windows) — the only
   non-blind option. Shows the exact write bytes and transfer setup. Gated on
   whether the 2015-era app still launches.
2. **Hardware firmware dump via SWD** — the band is an STM32L15x (Cortex-M3);
   SWDIO = PA13, SWCLK = PA14, NRST = pin 7. Read the RDP option byte first:
   RDP 0 = dumpable (`dump_image fuelband.bin 0x08000000 0x60000`), RDP 1 =
   flash reads blocked and lowering it mass-erases, RDP 2 = debug permanently
   off. A shipped consumer product is most likely RDP 1. In the firmware, the
   CRC-16 table (`0x1021`) is a recognizable landmark — the desktop-data parser
   and the imprint check sit near it.

---

## Tool reference

`tools/fuelband-dump.js` (needs `npm install` in `tools/`):

| flag | what it does |
|---|---|
| *(none)* | probe both framings + memory dump |
| `--recon` | read-only baseline: identity, status, all timestamps, account region |
| `--status` | status `0xdf`, decodes the imprinted bit |
| `--read-config` | desktop config read via `0x51` |
| `--memsweep` | sweep the desktop partition for non-`0xff` bytes |
| `--readmem <hex> <hex>` | read via `0x19` (sample store) |
| `--set-clock` | send `0x31` with current time, verify |
| `--fuzz` | sweep write framings, report which *engage* |
| `--writetest` / `--writetest2` / `--writetest3` | write-structure searches with read-back |
| `--fuzzwrite` | sweep opcodes for one that writes the region |
| `--imprint` / `--imprint2` | build + write config blob, sweep `imprint_state` |
| `--find <n>` | scan readable regions for a number shown on the band |

Read-only: `--recon`, `--status`, `--read-config`, `--memsweep`, `--readmem`,
`--find`. The rest write to the band (recoverable — hold the button ~10s for
RESET).
