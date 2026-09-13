# Nike+ FuelBand (1st gen) — USB protocol

Reverse-engineered from `FuelBandPlugin.dll` (extracted from the Nike+ Connect
installer with 7-Zip — an NSIS package of native DLLs), cross-checked against the
Android app, and verified against two physical bands.

The DLL retains its original C++ source filenames and log format strings
(`FuelBandCommands.cc`, `DesktopOptions.cc`, `UsbDeviceWin.cc`), which is what
made the command set and blob format recoverable.

## Status

| | |
|---|---|
| Transport | **solved** — including the `0x07` command wrapper |
| Reads | **solved** — identity, status, battery, clock, goal, fuel, memory, config region |
| Writes | **solved** — setters and the chunked config transfer, both verified byte-exact |
| Config blob format | **solved** — including the BE32 length header |
| Activation / imprint | **unsolved** — see §8 |

Two units, both factory-new, both firmware **F2.12**:

- **Band 1** (`20M9FC5V01660`) — clock, goal and 24-hour mode successfully written.
  Later **disabled** by opcode `0x14` during an opcode sweep; see §9.
- **Band 2** (`20M9FC6H01976`) — untouched reference unit. Read-only.

---

## 1. Device & transport

| | |
|---|---|
| USB ID | `11ac:6565` |
| Model string | `Nike+ FuelBand` |
| Hardware revision | `03` |
| Firmware | `F2.12` (raw `46 0c 02 61 4f 58 3d`) |
| Protocol version | `02` |

The version handler (`0x100408D0`) formats `sprintf("%c%u.%u", r[0], r[2], r[1])`
— **`r[2]` is major, `r[1]` is minor**, so `46 0c 02` reads `F2.12`, not `F12.2`.

The DLL calls the application core the **MSP** (`Get the MSP firmware version
number`), with a separate **network processor (NP)** owning its own
version/boot/reset/stage/flash commands. `0x0a` returns the ASCII string
`Not in boot` for the NP. That points at a TI MSP430 rather than the STM32 an
early note assumed — see §10 before buying a debug probe.

### HID report descriptor (read off a real band)

```
collection 0  usagePage:65280 usage:1
  feature: id 113 (7B)
  input:   id 4 (63B), id 3 (31B), id 2 (15B), id 1 (7B)
  output:  id 12 (63B), id 11 (31B), id 10 (15B), id 9 (7B)
```

Reports are **size-bucketed** — use the smallest bucket that fits the body:

| body | output id | reply id |
|---|---|---|
| ≤ 7B | 9 | 1 |
| ≤ 15B | 10 | 2 |
| ≤ 31B | 11 | 3 |
| ≤ 63B | 12 | 4 |

### WebHID cannot drive this device

WebHID only permits feature transfers on report IDs the descriptor *declares*
(here only 113, which itself won't read), and the band never emits input-report
events. Every read path fails from a browser. hidapi (`node-hid`) has no such
restriction — hence `fuelband-dump.js`. A browser limitation, not a device one.

### ★ The `0x07` command wrapper

**This is the single most important detail in the protocol.** Commands are not
sent bare. They are wrapped:

```
body = [ len+1, 0x07, <opcode>, <payload…> ]      sent as an OUTPUT report
                                                   on the fitting size bucket
reply read from FEATURE report 1
```

Replies come back as `[01, len, 0x07, …payload]`.

Sending `<opcode> <payload…>` **without** the `0x07` wrapper produces
`01 01 <opcode>` — an empty body, which by the DLL's own convention
(handler `0x10037C20`) means *"operation not recognized by firmware"*:

```
len = response.length()
if (len == 0)   -> "operation not recognized by firmware"
else if (r[0])  -> "ERROR"
else            -> "OK"
```

A long stretch of this investigation mistook that for the firmware lacking the
commands. It was the wrapper missing. **An empty reply means "you addressed me
wrongly" at least as often as it means "I don't implement that."**

Region-selected reads (`0x51`/`0xbb` + a 3-byte region) also answer on the plain
`[outId, len, opcode…]` framing with the reply on feature report 4, so both
framings are real; they are not interchangeable per command.

---

## 2. Command opcodes

Recovered from every `Submitting %02X` / `Completing %02X` log site by exact byte
pattern (`6a NN` push imm8 immediately preceding `68 <str>`), and cross-checked
against full disassembly of individual handlers.

> **Superseded:** an earlier table in this document was derived by pairing
> handlers to opcodes in the command-registration function. That pairing was
> **misaligned** and produced wrong values — most damagingly `time = 0x31`, which
> is actually 24-hour mode. Do not use it.

| opcode | command | payload |
|---|---|---|
| `0x08` | version | — |
| `0xe1` | serial | — |
| `0xe0` | model | — |
| `0xe2` | hardware revision | — |
| `0xdf` | status | — |
| `0x13` | battery | — |
| `0x60` | protocol version | — |
| `0x0a` | network-processor version | — |
| `0x21` | **clock** | `[time:4 BE][gmtOffset:4 BE][dstMinutes:1]` — `time` is **local** wall-clock seconds; the band ignores `gmtOffset` for display (see below) |
| `0x24` | fuel | — (read) |
| `0x25` | **goal** | `[type:1][goal:3 BE]` |
| `0x31` | **24-hour mode** | `[bool:1]` |
| `0x32` | metric units | `[bool:1]` — display only; storage is always imperial |
| `0x33` | weight | `u16` = kg x 2.20462262 x 10 -> **tenths of a pound** |
| `0x34` | height | `u16` = inches x 4 -> **quarter-inches** (cm / 2.54 to convert) |
| `0x35` | age | `[years:1]` |
| `0x36` | gender | reads `0x55` = ASCII `'U'` (unspecified) on a factory band |
| `0x37` | display orientation | |
| `0x38` | display goal options | |
| `0x39` | display format | |
| `0x3a` | display loop | reads `00 01 03 05` — four entries |
| `0x3b` | display message options | |
| `0x17` | sample query | — |
| `0x19` | read memory int (sample store) | `[addr:3 BE]` |
| `0xbb` | memory read | `[region:3][offset:3 BE]` |
| `0x51` | get/set desktop data | see §5 |
| `0x28` | run-state (`doRunState`) | `f1 29 <state>` + 4B BE offset if `state & 1` |
| `0x1c` | **restoreDefaults** — destructive | — |
| `0x1f` | sync finished | needs an LSO parameter |
| `0x07` `0x09` `0x0b` `0xf2` | transfers / network flash / firmware image | do not send casually |

### Full command-surface sweep (07-wrapped, whole opcode space)

F2.12 answers a number of opcodes that appear **nowhere in the DLL**. Values
below are from factory-state bands.

| opcode | reply | reading |
|---|---|---|
| `0x02` | `00` | |
| `0x05` | `06 06 7e 81 1a 81 18 12` | 8 bytes, possibly a unique ID |
| `0x06` | `06 01` | |
| `0x0d` | `00 00 00 00 00 00` | |
| `0x0e` | `00` | |
| `0x15` | `01 0f a7 0f c3 07 d0 01 a5 09 0b 86` (band 1) / `…0f d4 07 d0 02 5e…` (band 2) | **not** the goal — `07 d0` appears on both units, so it is a constant. Differing fields (`0f c3`/`0f d4`, `01 a5`/`02 5e`) look like ADC/sensor readings |
| `0x1d` | `02 02` | |
| `0x26` | `00 00 00 01 00 00 00 01` | two BE32 `1`s |
| `0x27` | `00` | |
| `0x2a`, `0x2b` | `00 00 00` | same 3-byte width as fuel/goal — plausibly steps and calories. `--export` reads these as steps/calories but also emits them as `counterA`/`counterB`; the mapping is circumstantial, not confirmed against a walked day. |
| `0x54` | `02` | |
| `0xc2` | `ff…ff d6 c3 4a 37 34 23` | trailing 6 bytes look like a **BLE MAC address** |
| `0xcb` | `00 00` | |
| `0xcc` | `00` | |
| `0xcd` | `00 00 01 00 55 06 00 6e 06 00 6e 06` | repeating 16-bit values ~1621/1646 — sensor/ADC readings? |
| `0xd0` | `cc` | |
| `0xde` | `01` | |
| `0xee` | `00 04 6c 00` | |
| `0xf1` | `01` | |
| `0xf3` | `00 00 00 00` | |
| `0xf4` | `05 00 01 00 00 00 01 00` | |
| `0xff` | `36 64 08 10` | build/calibration constant? |

`0x43`–`0x7f` is essentially barren: only `0x50`, `0x52`, `0x54` and `0x60`
answer, and all four return the identical byte `02` — a status code (probably
"needs arguments") rather than data. The meaningful surface is below `0x43`.

**No activation command was found.** The whole opcode space has now been swept
(excluding the transfer/flash opcodes, `0x14`, and `0x1c`) and nothing behaves
like a switch that sets the imprinted bit.

---

## 3. Reads (all verified)

```
07 08          -> 46 0c 02 61 4f 58 3d          firmware F2.12
07 e1          -> "20M9FC6H01976"               serial
07 e0          -> "Nike+ FuelBand"              model
07 e2          -> 03                            hw revision
07 df          -> 80 cf 3c 66 06 ff 0f 00       status (see §7)
07 13          -> 45 59 0f 76                   battery: 69%, charging, 3958 mV
07 60          -> 02                            protocol version
07 21          -> 38 73 95 07 00 00 00 00 00    clock (unix BE) + gmt + dst
07 25 00       -> 00 00 00                      goal
07 31          -> 00                            24-hour mode
07 24          -> 00 00 00                      fuel
07 17          -> 21 bytes, zeros + live timestamp   sample store (empty)
```

**Battery voltage is big-endian.** `0f 76` = 3958 mV at 69%; `10 5e` = 4190 mV at
100%. Little-endian yields ~30 V and is wrong.

Region-selected reads use the other framing:

```
51 50 37 36 <off:3>   -> 01 3d 51 01 <nextOffset:3> <56 data bytes>
bb 50 37 36 <off:3>   -> same shape
```

The desktop-data region is `50 37 36` (ASCII `P76`). The 3 bytes after the status
are the **running offset**, i.e. requested offset + bytes returned.

---

## 4. Writes (all verified against hardware)

Every setter works through the wrapper, and every one was confirmed by reading
the value back:

| command | before | written | read back |
|---|---|---|---|
| clock `0x21` | `38 6d 90 98` (Jan 2000 factory) | `6a 7a ad 81` | `6a 7a ad 81` ✓ and **ticking** |
| goal `0x25` | `00 00 00` | `00 07 d0` (2000) | `00 07 d0` ✓ |
| 24-hour `0x31` | `00` | `01` | `01` ✓ |

The clock was later observed at `6a 7a ae 93` — **274 seconds later** — so the
band keeps the time it is given. Settings persist across commands.

---

## 5. Config block (`DesktopOptions`) and the chunked transfer

### Transfer

Reconstructed from `0x100386f0` (annotated dump: `disasm-transfer.txt`) and
verified end to end. Each chunk is built in this exact append order:

```
[83 a2] [flag] [off>>16] [off>>8] [off&0xff] [data …]
```

sent as the body of opcode `0x51` — **through the `0x07` wrapper**.

- `extra` = `83 a2`, supplied by `doSetDesktopData` as an argument.
- `flag` = `0` first chunk, `1` continuation, `2` final. The rewrite to `2` is
  guarded by `test edx,edx; je`, so a **single-chunk transfer keeps flag 0**.
- Offset is the cumulative bytes-sent counter (`this+0x18c`), 24-bit big-endian.
- Data budget: `0x3c - 6 - 1` = **53 bytes** per chunk.

All transfer state is host-side (`this+0x180` buffer, `this+0x18c` offset,
`this+0x190` done flag). **Nothing is negotiated on the wire** — no BEGIN, no
setup command, no handshake, and no finalize: `doSetDesktopData` issues nothing
after the transfer, and the app's flow is *write → read back → compare DDBs*.

The band acks each chunk with the running offset:

```
01 05 07 00 <offset:3>        e.g. 00 00 04, then 00 00 35, 00 00 6a, 00 00 a1
```

Verified writing 4 B, 54 B and 161 B, each read back byte-exact.

### Blob format

```
[total length: 4 bytes BIG-ENDIAN] [payload …] [CRC-16: 2 bytes]
```

Parser at `0x100331F0`:

```
len = BE32(data[0..3])
require len >= 6 and len <= bytes received
ptr += 4 ; payload_len = len - 6
CRC-16/XMODEM over payload_len bytes, compared to the trailing 2 bytes
```

so `total = 4 + payload + 2 = len`. **The header is the total length, not
padding** — a header of zeros fails the `len >= 6` check immediately and the blob
is discarded before any field is read.

Payload: three fixed 48-byte identifier fields, then TLV options.

| offset | field |
|---|---|
| 0 | `DIN` (48B, Nike-issued) |
| 48 | `UDI` (48B, Nike-issued) |
| 96 | `device group config id` (48B, Nike-issued) |
| 144+ | TLV options |

TLV: `tag(2B BE) len(1B) value(len bytes, BE)`. Confirmed tags: `0x0001`
**weight units**, `0x0002` **height units** (both 1-byte flags — *not* weight and
height values; see the note below), `0x000b` **imprint_state** (u32), `0x0005` email.
Also serialized: birthdate, screen name, first name, band name, profile update
date, clock auto set.

### The clock field is LOCAL time, not UTC

Confirmed on hardware, and worth stating plainly because the obvious reading is
wrong. `0x21` takes `[time:4 BE][gmtOffset:4 BE][dstMinutes:1]`, which looks like
"UTC plus a zone so the device can localise it". It isn't.

**The band displays the `time` field verbatim and never applies `gmtOffset`.**
Sending UTC to a band in a UTC+2 zone made it show `08:26` while the wall clock
read `10:26` — exactly the offset, silently dropped.

So `time` must carry **local wall-clock seconds** (`epoch + offsetSeconds`), and
`gmtOffset` rides along as metadata the firmware stores but does not use for the
display. That is presumably how Nike's own client sent it: local time for the
screen, offset so the server could recover UTC afterwards.

Consequences worth knowing:

- A band written this way has **no idea what time zone it is in**. Travel across
  zones and it keeps showing the old local time until it is rewritten.
- `gmtOffset` is a signed value transmitted unsigned: UTC-5 goes out as
  `0xFFFFB9B0` (`-18000` read as int32).
- Anything reading the clock back must interpret the number **as UTC** to
  recover what the band is displaying — treating it as an epoch in local time
  double-applies the offset.

In this tool every clock write goes through one `clockPayload()` helper for
exactly that reason: three separate code paths used to build the payload
independently, and a fix to one would have left the others sending UTC and
silently undoing it. `--clock-utc` sends the old UTC form if any firmware turns
out to differ.

### CRC-16/XMODEM

Poly `0x1021`, init `0x0000`, MSB-first, no reflection, no final XOR (table at
`0x1005c700`). Verified against the canonical check value (`"123456789"` → `0x31c3`).

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

## 6. Status byte

`0xdf` byte 0, observed across both units:

| unit / state | byte 0 | bits |
|---|---|---|
| band 2, factory | `80` | `1000 0000` |
| band 1, factory | `80` | `1000 0000` |
| band 1, after clock + goal + 24-hour writes | `c8` | `1100 1000` |

Our writes set **bits 6 and 3** — most plausibly "clock configured" and "goal
configured". **Bit 0 is `imprinted`** and was never set by anything we sent.
Remaining bytes (`cf 3c 66 06 ff 0f 00`) are recorded but not decoded; byte 4 was
observed drifting `07` → `06`.

---

## 7. Factory baseline (band 2, untouched)

```
firmware   F2.12          protocol version 02       hw revision 03
serial     20M9FC6H01976  model "Nike+ FuelBand"
status     80 cf 3c 66 06 ff 0f 00   (imprinted = 0)
battery    69%, charging, 3958 mV
clock      38 73 95 07  -> 2000-01-05  (factory default)
goal 0     fuel 0        24-hour 0     sample store empty
```

---

## 8. What remains unsolved: activation

Both bands display a "connect to USB" prompt and never show a clock, even with
the clock set and running, because they are **un-imprinted**. The app's own log
string for this state is `Desktop data Uninitialized length, assuming new device.`

**The config blob does not drive the imprinted bit.** Fifteen well-formed blobs
were written and verified — correct BE32 header, valid CRC-16, twelve different
`imprint_state` values, and both empty and populated `DIN`/`UDI`/group-id fields.
The status byte never moved from `80 cf 3c 66 06 ff 0f 00` in any case. Combined
with the fact that Nike's own mobile client cannot write desktop data at all
(§9), the most likely reading is that **"desktop data" is storage the host owns
and the band does not interpret**.

**Timestamps read as unset and are not the trigger either.** `0x42 <id>` returns
`[timestamp:4 BE][id:1]`, and all four ids (device-init, assessment-start,
fuel-reset, goal-reset) read as zero on a factory band. Note the id is echoed
*last*, so a write is likely `42 <time:4 BE> <id>` — an attempt using
`42 <id> <time:4>` did not take, which is consistent with that ordering rather
than with the command being unsupported.

What we established:

- The config write commits (region read-back confirms the `00 00 00 a1` header)
  but **does not set the imprinted bit**.
- `doRunState` (`0x28`) is **rejected** even with the payload derived exactly
  from the DLL (`28 f1 29 01 00 01 51 80`). This one is a genuine refusal, not a
  framing error — the correct form was sent and returned an empty body.
- No prepare/begin/commit/finalize step exists anywhere in the desktop-data path.
- No firmware-version gate exists on that path either.

The blob's leading fields — `DIN`, `UDI`, `device group config id` — plus email,
birthdate, screen name and profile update date are **Nike account-issued values**
(§9). Nike shut down the Nike+ services on **30 April 2018**. It is therefore
possible that no fabricated blob will ever satisfy the firmware, and that the
"desktop data" region is storage the *host* owns and the band never interprets.

The activation trigger is not in the command surface we can name from the DLL.

---

## 9. What the Android app adds (`nike-fuelband.apk`, Apr 2015)

Decompiled with androguard. Targets the FuelBand **SE over BLE** ("Copperhead"),
not this band's USB path, but it settles the provisioning question.

**DIN is a server-issued UUID, and it is the auth key.** `Lfuelband/lb$a;` parses
a device record straight from a Nike service response — `serialNumber`,
`deviceId`, `firmwareVersion`, `manufacturer`, `deviceType`, **`din`** — into a
local SQLite `devices` table keyed by serial. On connect the app reads it back
(`SELECT din FROM devices WHERE serial_number = ? AND din NOT NULL`) and logs
`Din used for BLE Auth key:`. It is never computed client-side.

**Key derivation** (`Lfuelband/en;->a(String)`):

```java
UUID u = UUID.fromString(din);
byte[] b = ByteBuffer.allocate(16)
    .putLong(u.getMostSignificantBits())
    .putLong(u.getLeastSignificantBits()).array();
byte[] x = new byte[16];
for (int i = 0; i < 16; i++) x[i] = (byte)(L[i] ^ b[i]);
return MessageDigest.getInstance("MD5").digest(x);
```

with `L = b3 7e bf 75 c6 c7 19 24 a3 b1 88 4a 29 70 44 35`.

**The legacy fallback key is sixteen `0xFF` bytes** (`en->a`, filled with `-1`),
used when no DIN row exists — logged as `Using legacy auth token`. This
independently confirms the published all-`FF` SE auth result and explains it as
Nike's own no-DIN fallback rather than an external discovery.

**The mobile client cannot write desktop data at all:**
`Cmd_DesktopData.encode()` throws
`ProtocolCoderException("desktop data functionality is not supported")`. No
imprint or provisioning flow exists anywhere in the dex.

### Cross-version comparison of Nike+ Connect

| version | plugin | `do*` / `complete*` | desktop write |
|---|---|---|---|
| 4.1.2.42 | `FuelbandPlugin.dll` | **2 / 3** | absent |
| 5.3.8.37 | `FuelbandPlugin.dll` | 27 / 32 | `83 a2`, opcode `0x51` |
| 6.6 | `FuelBandPlugin.dll` | 29 / 32 | `83 a2`, opcode `0x51` |

4.1.2.42's plugin is a **near-stub** — Nike+ Connect 4.x predates mature FuelBand
support, so its missing `doSetDesktopData` reflects an immature host app, **not**
evidence the firmware command came later. 5.3.8.37 and 6.6 are the same protocol
(identical `0x3c` budget, offset construction, marker and opcode), so **no
alternative desktop-write form exists in any shipped version.**

Neither installer bundles firmware — Nike+ Connect downloaded it from its servers.

---

## 10. Incident: opcode `0x14` disabled band 1

During a blind opcode sweep (`--surface`), sending bare `0x14` caused
`IOHIDDeviceSetReport` to fail with an I/O timeout. The band's display went dark,
it stopped responding to the button, and it no longer enumerates over USB.

- `0x14` appears **nowhere** in the DLL — neither as a submit nor a completion
  opcode. Nike's own software never sends it.
- The failure was on the **write**, meaning the device stopped mid-transaction
  rather than returning an error — consistent with it cutting its own power.
- `0x13` is `battery`; a battery-control command adjacent to the battery query is
  a plausible layout, and the XML lists **`latchup` — "Turn off battery"**.

Best assessment: `0x14` is `latchup` or equivalent. Latchup is a shipping mode
and is *designed* to be exited by applying USB power, which is why a new band
wakes when first plugged in. The band was at 100% / 4190 mV when it went dark, so
this is not a flat cell. Recovery is a long charge on a powered USB-A source, plus
the 10-second button reset.

**Lesson recorded deliberately:** do not sweep unnamed opcodes against hardware
you cannot replace. The tool's sweep now skips `0x14`, guards every write, and
resumes after a hang — but the sweep should not have existed in that form.
`--safe` exists for read-only work and sends only documented getters.

---

## 11. Remaining paths

Both answer the same question: **what performs activation on F2.12?**

1. **USB capture of Nike+ Connect** (Wireshark + USBPcap on Windows) against a
   real band — shows everything the app sends, including anything earlier in the
   session that static analysis would not attribute to the desktop-data path.
   Gated on whether the 2015-era app still launches.
2. **Hardware firmware dump.** *Identify the silicon first.* The DLL calls the
   core the **MSP**, pointing at a **TI MSP430**, not an STM32:
   - MSP430 debugs over **JTAG or Spy-Bi-Wire** (`TEST`/`SBWTCK`, `RST`/`SBWTDIO`)
     with an MSP-FET and `mspdebug`. Protection is a **JTAG fuse** — blown is
     irreversible, with no STM32-style "lower RDP and mass-erase" middle ground.
   - Open the case and read the chip markings before buying a probe.

   The CRC-16/XMODEM table (poly `0x1021`) is a recognisable landmark in a dump;
   the desktop-data parser and whatever consumes `51 83 a2 …` should sit near it.

---

## Tool reference

`tools/fuelband-dump.js` — run `npm install` in `tools/` first.

**Read-only, safe:**

| flag | purpose |
|---|---|
| `--safe` | documented getters only — identity, status, battery, clock, goal, fuel |
| `--recon` | baseline: identity, status, timestamps, account region |
| `--status` | status `0xdf`, decodes the imprinted bit |
| `--probe2` | 07-wrapped reads of the wider command set |
| `--read-config` | desktop config block via `0x51` |
| `--memsweep` | sweep the desktop partition for non-`0xff` bytes |
| `--find <n>` | scan readable regions for a value shown on the band |

**Writes to the band:**

| flag | purpose |
|---|---|
| `--activate` | clock + goal + 24-hour through both framings, read back |
| `--xfer [hex…]` | send a payload through the chunked transfer, verify by read-back |
| `--ladder` | 4 B / 54 B / valid-blob transfers with read-back |
| `--imprint2` | write the config blob, sweep `imprint_state` |
| `--runstate [0\|1]` | `doRunState` with the exactly-derived payload |

**Dangerous — do not use casually:**

| flag | why |
|---|---|
| `--surface [lo] [hi]` | sweeps unnamed opcodes; this is what disabled band 1 |

---

## ACTIVATION ACHIEVED — imprinted bit set and persistent

### The imprint sequence, in full

There is no imprint *command*. Nothing in the protocol writes the `imprinted`
bit — the firmware sets it itself. What the host sends is an ordered batch,
which `--autoimprint` reproduces exactly:

```
  step  what                bytes on the wire                why it's there
  ────  ──────────────────  ───────────────────────────────  ─────────────────────────────
   1    access token        07 40 f3 3d ff 26 …28B… 00       must be present, non-empty
   2    refresh token       07 41 f3 3d ff 26 …32B… 00       same shape, longer value
   3    run-state           07 28 f1 29 12                   0x12, DERIVED from state 100
   4    timestamp reads     07 42 02   then   07 42 01       0x12 sets bits 0x02 and 0x10
   5    settings record     07 51 83 a2 …          × 6       277 bytes, six chunks
   6    option-age          07 35 1e                         the one profile field in-batch
   7    read-back           07 50 37 36 00 00 00             verify only — no commit exists
   8    clock               07 21 <unix:4> <gmt:4> 00        last, matching the DLL's order

  then: reset -> --provision (goal, metric, gender, 24h, age, clock) -> read status
```

Step 3 is **rejected on both bands** (reply `01 01 07`) and they imprinted
anyway. It stays in because it is what the app sent; it is demonstrably not the
trigger.

**The record (step 5).** Fixed header, then the ten tagged fields in exactly
this order, then the CRC:

```
  [len:4 BE] [DIN:48] [UDI:48] [groupConfigId:48]  <- fixed, NUL-padded
  ┌──────────────────────────────────────────────────────────────────────┐
  │  1. 0x01  weight units     flag    len 1   <- NOT a weight value     │
  │  2. 0x02  height units     flag    len 1   <- NOT a height value     │
  │  3. 0x0b  IMPRINT_STATE    u32 BE  len 4   <- = 100 (0x64) or nothing│
  │  4. 0x05  email            string  len N   <- length-prefixed, no NUL│
  │  5. 0x06  birthdate        string  len N                             │
  │  6. 0x07  screen name      string  len N                             │
  │  7. 0x0c  first name       string  len N                             │
  │  8. 0x0f  band name        string  len N   <- out of numeric order!  │
  │  9. 0x0d  profile update   i64 BE  len 8                             │
  │ 10. 0x0e  clock auto set   bool    len 1                             │
  └──────────────────────────────────────────────────────────────────────┘
  [CRC-16/XMODEM:2 BE]   over everything after the 4-byte length header
```

Every length must be exact: a known tag with the wrong length is skipped in
silence. `0x0f` really does precede `0x0d`.

**Tags 0x01 and 0x02 are unit flags, not measurements.** The naming in earlier
drafts ("metric weight", "metric height") invited the opposite reading. Two
independent lines of evidence:

1. **Struct layout.** The fields they deserialize into sit at member offsets
   `+0x00` and `+0x01` — two *adjacent single bytes* — with the `u32`
   imprint_state at `+0x04` (i.e. two bytes of alignment padding between them).
   A weight or height value cannot occupy one byte at `+0x01` with another field
   at `+0x00`. Only two 1-byte members produce that layout.
2. **The values live elsewhere.** Weight and height are not in this record at
   all. They are option commands — `0x33` weight (`u16`, tenths of a pound) and
   `0x34` height (`u16`, quarter-inches) — and the band stores both in imperial
   regardless of display. A *per-dimension display-unit* flag is exactly the
   missing piece, and explains why there are two flags rather than one: pounds
   with centimetres is a common US preference. (`0x32` is a third, separate
   units option.)

One caveat we cannot settle without the binaries: **`len 1` is solid, "bool" may
be too specific.** A 1-byte field could be a small enum rather than a flag —
lb / kg / stone, say, since stone is used for body weight in the UK. Anything
0–255 round-trips either way, so this does not change what we write.

**A test that would settle it**, for anyone with a band: write the record with
`0x01 = 1`, then read the weight option back with `--readprofile`. If `0x33` is
unchanged, `0x01` is definitively not a weight. Then try `0x01 = 0` vs `1` and
watch whether the band's own weight display switches between lb and kg.

**The chunking (step 5 continued).** 277 bytes over a transport that carries 53
data bytes per write:

```
  offset    0        53       106      159      212      265
            ├────────┼────────┼────────┼────────┼────────┼────┤
  data      53B      53B      53B      53B      53B      12B
  flag      0        1        1        1        1        2

  each write:  [0x51][83 a2][flag][offset:3 BE][data ≤53B]    (inside the 07 frame)
```

- The offset counts **data bytes only** — `83 a2` repeats in every chunk and is
  never counted.
- `flag` 2 marks the final chunk, but a transfer that fits in one chunk stays 0.
- The band acks each write with the running offset.
- **No begin, no commit, no flush.** The sequence just ends, which is why a
  half-written record leaves no trace of being half-written.

For this record (DIN/UDI `42…`, 28-byte access token, 32-byte refresh token,
names `user`/`Fuel`, imprint_state 100) the header is `00 00 01 15` = 277 and
the CRC is `6f 26`. Reproduce with `--canonical` and diff against your own.

---

A factory-blank gen-1 band (serial 20M9FC5V01660, firmware F2.12) was imprinted
over USB with no Nike servers, using `--autoimprint`.

```
before:  status c8 cf 3c 66 06 ff 0f 00   imprinted=0  mode=0
after:   status cf cf 3f 66 06 ff 0f 00   imprinted=1  mode=3
```

The bit survived a full power cycle (`doReset` 0x01 + magic `81 b4`, band
re-enumerated), so it is persisted in flash, not a runtime artifact. `mode` also
advanced 0 -> 3 and status byte 2 went 3c -> 3f: the firmware's own state
machine moved, which nothing prior had ever caused.

### What was different this time

Five things were simultaneously correct for the first time. Every earlier attempt
was writing a structurally invalid record:

1. **String TLVs length-prefixed** (`[tag][len][bytes]`, no trailing NUL).
   Previously the length byte was omitted, so the parser read the first character
   of the string as a length and desynced from tag 0x05 onward -- tags 0x06, 0x07,
   0x0c, 0x0f and 0x0d were never parsed at all.
2. **imprint_state = 100 (0x64, "Complete")**. Earlier values (1/2/3) all fell in
   the firmware's `< 20` "do nothing" branch.
3. **0x01/0x02 as bools with len 1**, not u32 -- a known tag with the wrong
   length is silently skipped.
4. **0x0e (clock auto set) emitted**, which Nike always writes and we omitted.
5. **run-state 0x12 sent before the DDB write**, matching saveDesktopAttributes'
   real order.

Plus the access token (0x40) was written, and echoed back correctly.

### Not yet isolated

This was a combined change, so which element was decisive is unknown. Notes for
anyone reproducing:
- The DDB loop wrote imprint_state 100, then 30, 20 and 10, so the record left on
  the band ends at 10 (SetupComplete), yet the bit still set.
- `0x41` (refresh token) and the run-state write both replied `01 01 07` (empty
  body), the "not recognised" shape -- so run-state may not have been accepted in
  that form even though the sequence as a whole succeeded.
- Both timestamps still read zero immediately before the DDB writes.

A second blank band is the way to isolate the cause.

### REPRODUCED on a second band

Band 2 (serial 20M9FC6H01976), a pristine control at factory status 0x80, was
also imprinted — over USB, no Nike servers.

```
80  ->  c0   (--autoimprint: bit6 set, byte2 3c->3f, imprinted still 0)
c0  ->  c7   (--provision:   imprinted = 1, mode 0 -> 3)
```

Two bands, two different serials, both activated. Not a fluke.

### What the isolation runs actually showed

Testing single variables on the pristine band ruled several things out:

- **The corrected DDB alone is NOT sufficient.** `--canonical` landed cleanly
  (gd-len 0xc3 matched the 195-byte record) and imprinted stayed 0. So the TLV
  format fix was necessary but not sufficient.
- **run-state is not involved.** `[0x28, f1, 29, state]` is rejected on BOTH
  bands (reply `01 01 07`, the empty-body "not recognised" shape), and it never
  stamps the timestamps. Band 1 imprinted despite run-state being rejected, so it
  cannot be the cause. Our marker payload is evidently wrong.
- **goalSet is NOT the precondition.** Band 2 imprinted with goalSet still 0.
  (Band 1 happened to have it set from earlier option writes; that was a red
  herring.)
- **bit6 is not "desktop data present".** `--canonical` wrote a record and left
  bit6 clear; bit6 only set during the fuller sequence.
- Both firmware timestamps (device-init, assessment-start) remained **zero**
  throughout, on both bands, even after imprinting. So the assessment state
  machine is not a precondition either.

### Working recipe (empirical)

On a blank band:
```
node fuelband-dump.js --autoimprint     # corrected DDB + access token + reboot
node fuelband-dump.js --provision       # profile: metric, gender, 24h, goal, age, clock
node fuelband-dump.js --checklist       # imprinted = 1
```
The single decisive command is still not isolated — the requirement appears to be
a **fully configured profile** alongside the corrected record and the access
token, rather than one magic opcode. `--provision` supplies the option writes
(0x31/0x32/0x35/0x36/0x25 + clock) that `--autoimprint` alone does not.
