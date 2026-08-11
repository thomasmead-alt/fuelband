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
| Test unit serial | `20M9FC5V01660` |
| Test unit firmware | **F2.12** — raw `46 0c 02 61 4f 58 3d` |

The version handler (`0x100408D0`) formats it as `sprintf("%c%u.%u", r[0], r[2], r[1])`
— note **`r[2]` is major and `r[1]` is minor**, so the raw bytes `46 0c 02` read
`F2.12`, not `F12.2`. (An earlier revision of this document had them transposed.)

The DLL calls the main processor the **MSP** (`<command name='version'
description='Get the MSP firmware version number'>`), with a separate **network
processor (NP)** that has its own version/boot/reset/stage/flash commands. That
points at a TI MSP430 for the application core rather than the STM32 an earlier
note assumed — see §8 before buying a debug probe.

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

## 5. The write path — reconstructed, and rejected by this firmware

The app's write was reconstructed byte-for-byte from the transfer routine at
`0x100386f0` (annotated dump: `disasm-transfer.txt`). A chunk is built in this
exact append order:

```
[extra][flag][off>>16][off>>8][off&0xff][data…]      sent as the body of 0x51
```

- `extra` = `83 a2`, supplied by `doSetDesktopData` (`0x1003AE10`) as arg4.
- `flag` = `0` first chunk, `1` continuation, `2` final. The rewrite to `2` at
  `0x10038912` is guarded by `test edx,edx; je`, so a **single-chunk transfer
  keeps flag 0** and never produces a final marker.
- Offset is the cumulative bytes-sent counter (`this+0x18c`), 24-bit big-endian.
- Data budget: `0x3c - 6 - 1` = **53 bytes** per chunk.

Device-side state lives entirely in the app's own object — `this+0x180` payload
buffer, `this+0x18c` bytes sent, `this+0x190` transfer-complete flag. **Nothing
is negotiated on the wire**: there is no BEGIN, no setup command, and no
handshake. `FuelBandTransfer` in `fuelband-dump.js` implements this exactly.

### The surrounding transaction has no finalize step

Traced from `doSetDesktopData` entry to return: after the transfer call it sets
async result `0xb`, frees the temp string, and returns — **it issues no further
command**. The `Desktop Data readback: wrote %u bytes, read %u bytes` log lives
in `completeGetDesktopData` (`0x1003AF40`), alongside `Creating DDB objects from
data written and read back, for comparison` and `DDB's are equivalent.` So the
app's real sequence is:

```
write chunks  ->  read the region back  ->  compare the two DDBs
```

No commit, no flush, no prepare/erase anywhere in the desktop-data path. The app
expects a successful write to be **immediately visible to the same read**.

### What the band actually does

### What `01 01 51` means — per Nike's own code

The completion handler at `0x10037C20` defines the convention:

```
len = response.length()
if (len == 0)   -> "operation not recognized by firmware"
else if (r[0])  -> "ERROR"
else            -> "OK"
```

Our write replies are `01 01 51` = report ID, length 1, opcode, and **zero
payload bytes** — an empty response body. By the DLL's own definition that is
*operation not recognized by firmware*, not a silent accept. This settles the
earlier ambiguity about whether the writes were being taken and staged.

Note also that the DLL contains **no firmware-version gate on the desktop-data
path** — it does not branch by version before sending the write. The only
known/unknown version check is for the *bootloader* (`device.bootloader.version-is-unknown`,
set when a system-reserved field reads zero), unrelated to this.

| test | result |
|---|---|
| `0x31` set clock (feature-write, then output-report, both framings) | acked, no effect |
| A — 4B payload, single chunk (flag 0) | `01 01 51`, region unchanged |
| B — 54B payload, two chunks (flags 0,2) | `01 01 51`, region unchanged |
| C — 161B valid blob, 4 chunks (flags 0,1,1,2), correct CRC | `01 01 51`, region unchanged |
| transfer-state sample (bare `0x51`) after each of A/B/C | identical to baseline — nothing staged |
| commit candidates `0x28`, `0x50`, `0x53`, `0x54` | echo only, region unchanged |

### Region-existence probe (decisive)

If `83 a2 <flag>` is the low byte of a 24-bit region selector rather than a
protocol prefix — which matches the read form `[opcode][region:3][offset:3]` —
then the region can be probed directly in the read form:

| region | reply | |
|---|---|---|
| `0x503736` (control) | `01 3d 51 01 00 00 38 ff…` | **exists** |
| `0x83a200` | `01 01 51` | not recognised |
| `0x83a201` | `01 01 51` | not recognised |
| `0x83a202` | `01 01 51` | not recognised |

**Conclusion.** This band does not act on the write form the 2015 Nike+ Connect
DLL emits, under any construction we can produce, and stages nothing. Whether
that is because region `0x83a2xx` does not exist in firmware `F2.12`
(`46 0c 02 61 4f 58 3d`), or because `83 a2` is a prefix requiring device state
we cannot establish, is **not distinguishable from outside** — both produce the
identical bare echo.

Static analysis of the DLL is exhausted for this path: the packet construction,
the transaction around it, and the absence of any finalize step are all now
established facts, and the band still refuses. What remains is not "which packet
did we miss" but "what does this firmware implement".

> **Caveat on the wording.** "Region `0x83a2xx`" and "prefix `83 a2` plus a flag"
> are the *same bytes on the wire* and cannot be distinguished by any external
> test. Do not record this as "the firmware lacks region `0x83a2xx`" — the
> falsifiable claim is that **the band does not act on `51 83 a2 …`**. Anyone
> inspecting a firmware dump should look for the handler that consumes that
> sequence, not for a region table entry.

### Loose end: `0x51` replies are length-dependent

The handler's reply varies with command length in a way we have not mapped, and
one observation was not reproducible across sessions:

| sent | reply |
|---|---|
| `51` (alone) | `01 01 51` |
| `51 de ad be ef` (op + 5) | `01 02 51 01` |
| `51 0d de ad be ef` (op + 5, different lead) | `01 07 51 00 00 00 00 00 00` |
| `51 83 a2 00 00 00 00` (op + 6, unknown region) | `01 01 51` |
| `51 50 37 36 00 00 00` (op + 6, known region) | `01 3d 51 01 00 00 38 …` |

An earlier fuzz run got `01 02 51 01` / `01 07 51 …` from short `0x51` forms; a
later run returned `01 01 51` for comparable inputs. That is the only hint of
session-dependent state we have seen, and it is worth re-checking during a USB
capture — it may indicate the handler behaves differently once the device has
been put into some mode we never established.

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

## 7a. What the Android app adds (`nike-fuelband.apk`, Apr 2015)

Decompiled with androguard. The app targets the **FuelBand SE over BLE**
("Copperhead" protocol), not this band's USB path, but it answers the
provisioning question directly.

### DIN is a server-issued UUID, and it is the auth key

`Lfuelband/lb$a;->a(JSONObject)` parses a device record straight from a Nike
service response — keys `serialNumber`, `deviceId`, `firmwareVersion`,
`softwareVersion`, `manufacturer`, `deviceString`, `deviceType`, **`din`** — and
writes it into a local SQLite `devices` table keyed by serial number.

On connect (`Lcom/nike/fuel/device/v;->a`), the app reads the row back
(`SELECT din FROM devices WHERE serial_number = ? AND din NOT NULL`) and logs
either `DIN is null for serial number:` or **`Din used for BLE Auth key:`**.

So the DIN is a **stored per-device secret obtained from Nike's service**. It is
never computed on the client. That is the same `DIN` the desktop config blob
carries as its first 48-byte field.

### Key derivation (fully recovered)

`Lfuelband/en;->a(String)[B`:

```java
UUID u = UUID.fromString(din);                        // the DIN is a UUID
byte[] b = ByteBuffer.allocate(16)
    .putLong(u.getMostSignificantBits())
    .putLong(u.getLeastSignificantBits()).array();
byte[] x = new byte[16];
for (int i = 0; i < 16; i++) x[i] = (byte)(L[i] ^ b[i]);
return MessageDigest.getInstance("MD5").digest(x);    // 16-byte auth key
```

with the hardcoded constant `L = Lfuelband/en;->l`:

```
b3 7e bf 75 c6 c7 19 24 a3 b1 88 4a 29 70 44 35
```

### The legacy fallback key is sixteen 0xFF bytes

`Lfuelband/en;->a` is initialised as `new byte[16]` filled with `-1`. When no
DIN row exists, `Lcom/nike/fuel/device/aa;->a` logs `Using legacy auth token`
(and, on one branch, `Using legacy auth token.  Todd was wrong`) and
authenticates with that all-`FF` array.

This independently confirms the published SE result that an all-`FF` token
authenticates, and explains *why*: it is Nike's own no-DIN fallback path, not a
flaw discovered from outside.

### The mobile client cannot write desktop data

`NikeProtocolCoder_Copperhead$Cmd_DesktopData` (extends `Cmd_GenericMemoryBlock`)
implements `decode()` by delegating to the generic memory-block reader, but
`encode()` is:

```java
throw new ProtocolCoderException("desktop data functionality is not supported");
```

**Desktop-data writing was a Windows/USB-only capability.** There is no imprint
or provisioning flow anywhere in the APK — no `imprint` string occurs in the
dex at all. The phone consumes a DIN that the service already issued; it never
creates one.

### Bearing on this investigation

This does **not** unblock the gen-1 USB write. Our band fails at command
recognition, not authentication — there is no auth handshake in the USB
protocol, so a key is not what is missing. What it does settle is the
provisioning question: the identifiers in the config blob originate from Nike's
service, keyed by serial number, and no client ever synthesised them.

## 7b. Cross-version comparison of Nike+ Connect

Three installer versions were extracted and compared, to test whether an older
desktop app used a different (older) desktop-write form that this band's
factory firmware might accept.

| version | plugin | `do*` / `complete*` handlers | desktop write |
|---|---|---|---|
| 4.1.2.42 | `FuelbandPlugin.dll` | **2 / 3** | absent |
| 5.3.8.37 | `FuelbandPlugin.dll` | 27 / 32 | `83 a2`, opcode `0x51` |
| 6.6 | `FuelBandPlugin.dll` | 29 / 32 | `83 a2`, opcode `0x51` |

**4.1.2.42's plugin is a near-stub** — two `do*` handlers in total. It parses
`DesktopOptions` (the `.cc` name and "Cannot determine desktop data length from
only %d bytes" are present) but implements almost no commands. Nike+ Connect 4.x
predates mature FuelBand support, so its lack of `doSetDesktopData` reflects an
immature *host application*, **not** evidence that the firmware command was
introduced later. (An earlier reading of this comparison over-claimed that; it
is not supported.)

**5.3.8.37 and 6.6 are the same protocol.** Both build the chunk with the
identical `0x3c` budget and the same `shr 0x10` / `and 0xff` × 3 big-endian
offset construction, both use marker `83 a2`, both submit opcode `0x51`.

So **no alternative desktop-write form exists in any shipped version.** The
sequence we reconstructed is the only one Nike ever used over USB, and the
band's rejection is not a host-version mismatch.

Neither installer bundles a firmware image — Nike+ Connect downloaded firmware
from its servers (`convert.fwversion` is the only firmware-file reference).
That leaves one hypothesis this comparison *cannot* rule out: the band's factory
firmware may predate the desktop-write command, with Nike+ Connect upgrading it
on first connect via `doMainUpgrade` / the `0x09` image transfer. If so, the
missing artifact is an archived FuelBand firmware image, not a protocol detail.

## 8. Remaining paths

Both remaining routes answer the same, now precisely-stated question: **does
firmware `F2.12` implement region `0x83a2xx`, and what gates it?**

1. **USB capture of Nike+ Connect** (Wireshark + USBPcap on Windows) — shows
   what the real app sends *to this band*, including anything earlier in the
   session that static analysis wouldn't attribute to the desktop-data path. If
   a capture shows `0x83a2xx` sent and ignored, the firmware-gate hypothesis
   becomes dominant. Gated on whether the 2015-era app still launches.
2. **Hardware firmware dump.** *Identify the silicon before buying a probe.* The
   DLL calls the application core the **MSP**, which points at a **TI MSP430**,
   not the STM32 an earlier revision of this document assumed. That changes the
   toolchain completely:

   - **MSP430** debugs over **JTAG or Spy-Bi-Wire** (2-wire: `TEST`/`SBWTCK`,
     `RST`/`SBWTDIO`) using an MSP-FET / TI LaunchPad and `mspdebug`. Protection
     is a **JTAG fuse** (blown = irreversible lockout, no recovery) plus an
     optional BSL password — *not* STM32-style RDP levels, and there is no
     "lower the protection and mass-erase" middle ground.
   - Open the case and read the chip markings first. If it really is an STM32,
     the SWD route applies instead (SWDIO/SWCLK/NRST, check the RDP option byte,
     `dump_image fuelband.bin 0x08000000 0x60000`).

   Whatever the core, the CRC-16/XMODEM table (poly `0x1021`) is a recognisable
   landmark in the dump; the desktop-data parser and the handler that consumes
   `51 83 a2 …` should sit near it.

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
