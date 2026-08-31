# Nike+ Connect — how the original software works

A reference for the desktop software that talked to the Nike+ FuelBand, reconstructed
by reverse-engineering the shipped binaries. Everything here is derived from the
2012–2015 builds; anything uncertain is flagged as such.

Companion docs: [`PROTOCOL.md`](PROTOCOL.md) (the USB wire protocol) and
[`mitm/MITM-SETUP.md`](mitm/MITM-SETUP.md) (running the app against a fake server).

---

## 1. What ships in the box

Nike+ Connect is a **32-bit** desktop app (Windows `x86`, macOS `i386` Mach-O) built
on the **JUCE** UI framework. It is a host for *device plugins* — one shared library
per product family:

| Binary | Device family | Notes |
|---|---|---|
| `Nike+ Connect` / `.exe` | — | Main app: UI, imprint state machine, web managers, config |
| `fuelbandplugin.dylib` / `FuelBandPlugin.dll` | **FuelBand gen-1** | Our target. USB/HID only. |
| `fuelbandseplugin.dylib` / `FuelBandSEPlugin.dll` | FuelBand SE | Internal codename **"Copperhead"** |
| `sportbandplugin` | SportBand | Uses a PIN + JSP API, *not* the FuelBand flow |
| `sportwatchplugin`, `espplugin` | SportWatch, ESP sensors | |
| `Nike+ Connect Helper Daemon` | — | Background helper |
| `libcurl`, `libeay32`/`ssleay32` | — | HTTP + OpenSSL (not the system TLS stack) |

The build left a lot behind: log format strings carry **original C++ source filenames**,
which is why this was tractable at all. Known translation units include
`FuelBandCommands.cc`, `DesktopOptions.cc`, `FuelbandWebManager.cc`, `Fuelband.cc`,
`Copperhead.cc`, `FuelBandImprintingScreen.cc`, `WebManager.cc`, `HttpRequest.cc`,
`ConfigFile.cc`, `WebServices.cc`, `MfgDate.cc`. The Windows PDB path shows a Jenkins
job: `NikePlus-Connect-Windows-Release`.

---

## 2. Object model

```
NikeSportDevice                     (abstract base for every device)
   └── FuelBandPlugin::FuelBandDevice   (gen-1)
FuelBand2Plugin::FuelBandDevice        (SE — note: separate class, separate plugin)

NikeAttributeSet_I        key/value bag: "athlete.1.din", "device.status.imprinted", …
NikeCommandProgressListener_I   async completion callbacks
UsbExchangeThread         the USB transport (see §4)
DesktopOptions            the on-band settings record (see §5)

Connect::Fuelband         app-side gen-1 device controller
Connect::Copperhead       app-side SE controller
FuelbandWebManager        the Nike web API client
FuelbandImprintingScreen  the activation UI + state machine
```

**Everything is attribute-driven.** Commands don't take positional arguments; they read
named attributes out of a `NikeAttributeSet_I`. That's why the plugin is full of errors
like `doAccessToken need accessToken` and `doRunState need marker parameter` — a command
whose attribute is missing simply fails.

Each command is a pair:
- `doXxx(attrs, …)` — builds the byte payload and submits it
- `completeXxx(response, …)` — parses the reply back into attributes

---

## 3. Configuration — two separate systems

This trips people up, so it's worth being precise. There are **two** config blobs, both
XOR-obfuscated with the same key, handled by different code and containing different things.

| | `ConfigFile.cc` | `WebServices.cc` |
|---|---|---|
| Content | Device/firmware **manifest**: firmware images, app versions, first-use panels, help URLs | **Service endpoints**: hostnames + every API URL |
| Format | XML `<nikeApplicationConfiguration>` | JSON (`production.json`) |
| Embedded resource | `config_xml_obtxt` | `production_json_obtxt` |
| External override | **Yes** — `config.dat` on disk | **None** — embedded only |

**Obfuscation:** a single repeating 16-byte XOR:
```
29 9f 60 1a d2 14 47 c2 b2 26 d5 f3 fa 59 9b 4c
```
Key phase 0 aligned to the blob start; the blob is NUL-terminated. (v4's config was
**plaintext**; obfuscation arrived in v5.)

**`config.dat`** lives at `~/Library/Application Support/Nike/Nike+ Connect/config.dat`
(macOS) or `%APPDATA%\Nike\Nike+ Connect\config.dat` (Windows), is **plaintext XML**
(not obfuscated), and must declare an `<appVersion internalVersion="X">` matching the
running binary or it's rejected. **It contains no hostnames** — it cannot redirect API
traffic.

**The services JSON** is the only place hostnames live:
```json
"base-host-name":        "nikeplus.nike.com",
"secure-base-host-name": "secure-nikeplus.nike.com",
"api-host-name":         "api.nike.com",
"keryx-host-name":       "prd-msp-keryx.nike.com"
```
Every endpoint is built by interpolation — `"https://${api-host-name}/v1.0/device/imprint?…"` —
and **no endpoint hardcodes a host**, which is what makes `tools/mitm/patch-hosts.js` work.
The scheme, however, *is* baked into each URL string.

---

## 4. USB transport

The band is a **USB HID** device, `11ac:6565`. Notably the descriptor only declares
feature report 113, which is why **WebHID cannot drive it** — you need raw hidapi.

**Size-bucketed reports.** Output report IDs 9/10/11/12 carry 7/15/31/63-byte payloads;
pick the smallest that fits. Replies come back on feature report IDs 1/2/3/4.

**The `0x07` wrapper.** This is the single most important detail. Commands are not sent
bare — they're wrapped:

```
output report:  [len+1, 0x07, <opcode>, <payload…>]
reply (feat#1): [01, len, 0x07, <payload…>]
```

Send an opcode *without* the wrapper and the band replies `01 01 <opcode>` — an empty
body, which the plugin's own convention calls *"operation not recognized by firmware."*
That reply is a trap: it usually means you framed the request wrongly, **not** that the
command is missing.

**Two submission paths** on `UsbExchangeThread`:
- `submit(opcode, data, …)` — request/response. Used by everything normal.
- `send(opcode, data, …)` — fire-and-forget, no reply expected. Used only by the
  reset class: `0x01` reset (payload `81 b4`), `0x02` restoreDefaults, `0x03` latchup,
  `0x04` bootblock (payload `18 a1`).

**Chunked writes** (the settings record). Each chunk is the body of opcode `0x51`:
```
[0x83 0xa2][flag][off>>16][off>>8][off&0xff][data … ≤53 bytes]
```
`flag` = 0 first, 1 continuation, 2 final (the rewrite to 2 is guarded, so a
single-chunk transfer stays 0). The offset counts **data bytes only** — the `83 a2`
prefix repeats in every chunk and isn't counted. The band acks each chunk with the
running offset. There is **no begin, no commit, and no flush**: the sequence ends with a
read-back (`0x50 37 36 00 00 00`) used purely to verify.

---

## 5. `DesktopOptions` — the on-band settings record

The band's persistent settings live in one CRC-checked binary record ("the DDB"),
written with `0x51` and read with `0x50`.

**Container:**
```
[total length: 4 bytes BIG-ENDIAN]
[DIN: 48 bytes][UDI: 48][deviceGroupConfigId: 48]   fixed, NUL-padded, no length prefix
[TLVs …]
[CRC-16/XMODEM: 2 bytes BE]
```
`total` = whole record (payload + 6). CRC covers everything after the length header,
excluding the CRC itself. The parser accepts `total <= received_length` (not `==`).

The three identity fields are written by copying **at most 47 bytes** and padding to 48,
so byte 48 is always the pad — guaranteeing NUL-termination for the parser's `strlen()`.

**TLV wire form:** `[tag u16 BE][len u8][value]`, advance `len + 3`. The loop stops when
fewer than 4 bytes remain or the next tag byte is `0xFF`.

| Tag | Field | Type |
|---|---|---|
| `0x01` | metric weight | bool, len **must** be 1 |
| `0x02` | metric height | bool, len 1 |
| `0x05` | email | string (length-prefixed, **no NUL**) |
| `0x06` | birthdate | string |
| `0x07` | screen name | string |
| `0x0b` | **imprint_state** | u32 BE, len **must** be 4 |
| `0x0c` | first name | string |
| `0x0d` | profile_update_date | i64 BE, len **must** be 8 |
| `0x0e` | clock auto set | bool, len 1 (default **1**) |
| `0x0f` | band name | string |

Emission order is `01 02 0b 05 06 07 0c 0f 0d 0e` (note `0f` really does precede `0d`).
Tags `0x00, 0x03, 0x04, 0x08, 0x09, 0x0a` are unknown/passthrough — the writer re-emits
any it saw on read, verbatim.

**Gotchas that cost us a lot of time:**
- A known tag with the **wrong length is silently skipped**, not an error.
- **No tag is required.** The parser only fails on a bad length header or CRC mismatch.
- Strings are length-prefixed on the wire; the parser's `getString` reads NUL-terminated
  C strings out of the *parsed* buffer. Writing a NUL instead of a length byte desyncs
  the entire record from that tag onward.

---

## 6. The command surface

The plugin embeds a `commands.xml` spec (42 commands, ~7.3 KB) declaring each command's
**inputs** — but no outputs; response shapes live in the `complete*()` handlers. The XML
is a **subset** of what the firmware answers: several handlers (`readSystemReserved`,
`assessment-metrics`, `fault-log`) exist in the binary but not in the spec.

Selected opcodes (full table in `PROTOCOL.md`):

| Opcode | Command | | Opcode | Command |
|---|---|---|---|---|
| `0x08` | version | | `0x40` | access token |
| `0x13` | battery | | `0x41` | refresh token |
| `0x1f` | sync-finished | | `0x42` | timestamp (`[id]`) |
| `0x21` | time | | `0x50` | getDesktopData |
| `0x25` | goal | | `0x51` | setDesktopData |
| `0x28` | run-state | | `0x52` | readMemoryInt (`[0x37, bank, off:3]`) |
| `0x31`–`0x3b` | options / display | | `0xce` | readSystemReserved (`[field 0–15]`) |
| `0x17` | assessment-metrics | | `0xdf` | status |
| `0x06` | fault-log | | `0xe0`–`0xe2` | model / serial / hw revision |

**Destructive — do not send casually:** `0x1c` eeprom-erase (needs a magic value),
`send 0x02` restoreDefaults, `send 0x03` latchup (turns the battery off), `send 0x04`
bootblock, and the firmware-flash family. Note `save` appears in the XML but has **no
handler and no opcode** — it is a no-op that never existed.

**Status byte 0** (opcode `0xdf`) decodes as:

| bit | meaning |
|---|---|
| 0 | **imprinted** |
| 1–2 | mode |
| 3 | goalSet |
| 4 | powerDay |
| 5 | airplaneMode |
| 7 | serialSet |

---

## 7. Activation ("imprinting")

This is the part that matters for reviving a band, and the part that's server-gated.

**The state machine.** `ImprintingState` is a value/name table in the app's `.rdata`.
It is a **0–100 progress scale**, not a small enum:

| v6 (7 states) | | v4/v5 added |
|---|---|---|
| `0` Fresh | | `35` StartFirst24 |
| `3` TimeSet | | `40` InFirst24 |
| `5` DinGenerated | | `50` First24Done |
| `10` SetupComplete | | `60` InitialGoalSet |
| `20` InFirstCharge | | |
| `30` FirstChargeComplete | | |
| **`100` Complete** | | |

Every "is imprinting finished" check in the app compares against **100**. Note `20` is
`InFirstCharge` even though a nearby log line says *"Imprint-State = SETUP COMPLETE"* —
the log text is not the enum name.

**The web flow** (`FuelbandWebManager`), all against `${api-host-name}`:
```
POST /v1.0/device/imprint        → server issues DIN + UDI
GET  /map/getAccessToken?din=…   → access_token, refresh_token, expires_in
GET  /v1.0/device/onetimetoken   → token for the browser setup page
     (user completes setup in a web page)
GET  /events/connect/<udi>       → keryx event queue → eventType "setup_complete"
POST /events/connect/<udi>/ack/<id>
GET  /v1.0/me/device/<udi>/settings, /v1.0/me/profile, …
```
The **DIN is server-issued and server-validated** — it's exchanged for an OAuth token.
There is no local DIN algorithm and no relation to the serial number. Critically, there
is **no cryptography at all** in the gen-1 plugin (no MD5/SHA/HMAC/AES/nonce), so the
DIN is handled as an opaque string end-to-end.

**The device-side save batch** (`saveDesktopAttributes`) is short:
```
1. run-state  (0x28, payload F1 29 <state>)     ← derived from imprint_state
2. timestamp reads 0x42 02 and/or 0x42 01        ← per bits 0x02 / 0x10 of run-state
3. option-age (0x35)                             ← only if age derives from the dob
4. chunked DesktopOptions write (0x51)
5. read-back  (0x50 37 36 00 00 00)
```
Run-state is derived, not chosen:
```
imprint_state == 100 → run-state 0x12
imprint_state <   20 → no change at all
otherwise (20…99)    → run-state 0x02
```

**Who sets the `imprinted` bit?** Not the host. `completeStatus` only *reads* it, and —
unlike the SE plugin, which exports `saveDeviceImprintState()` and `isImprinted()` — the
gen-1 plugin exports **neither**. The gen-1 firmware sets the bit *itself*, on a condition
the host protocol never asserts directly. That condition is the one thing this whole
investigation has not pinned down.

**A device-side lead:** the band runs its own **assessment** state machine. Older builds
gated the First24 states on it, polling run-state for `ASSESSMENT COMPLETE`, reading
`device.timestamp.assessment-start`, and erroring with *"assessment-started timestamp is
zero!"*. If a completed assessment is a precondition for imprinting, no server mock can
satisfy it.

**A blank band gets *less* traffic, not more.** On an uninitialised record the app logs
*"Desktop data Uninitialized length, assuming new device"* and sends **zero bytes** to
the device; with no access token, `rebuildDesktopData` just sets imprint-state 0
host-side and returns. There is no first-time-only device initialisation step.

---

## 8. TLS, and why interception is easy

`HttpRequest.cc` calls `curl_easy_setopt` with **`CURLOPT_SSL_VERIFYPEER = 0`** and
**`CURLOPT_SSL_VERIFYHOST = 0`**, and the app ships **no CA bundle** at all. It uses its
own OpenSSL-backed libcurl, not the system trust store.

So the app accepts **any** certificate. Impersonating Nike's API needs no certificate
authority, no keychain trust, and no pinning bypass — only a self-signed cert. The one
leg that *does* verify is the browser-opened setup page, because that runs in the
system browser.

---

## 9. Version differences

Four builds were examined: **v4.1.2.42** (2012), **v5.3.8.37** (2013), the **2014 macOS**
build, and **v6.6.34** (2015).

- The imprint architecture is **identical in all of them** — same OAuth + browser +
  keryx-event flow, same server dependency. No build has an offline, debug, or bypass
  path, and no CLI flag or environment variable drives imprinting.
- v4/v5 have the **richer 11-state** enum; v6 removed the four First24 states.
- v4's config is **plaintext** and points at **staging** (`api.stage.nike.com`); v5/v6 are
  obfuscated and point at production. `client-id`/`client-secret` differ per build.
- v4's plaintext JSP/PIN endpoints (`generate_pin.jsp` etc.) belong to the **SportBand**
  section of the config, not the FuelBand — they cannot imprint a FuelBand.
- v6 added SE-specific keys (`fbse-fake-reset`, `disable-brick-update`); none affect gen-1.

---

## 10. What is *not* in the software

Worth stating explicitly, because each was checked:

- **No firmware image** is bundled in any installer — firmware was downloaded on demand.
  The decoded config yields the real download URLs and SHA-1s (e.g. F2.35 at
  `go.nike.com/fbappfw2035`, `c224771d…`), all on now-dead hosts.
- **No mobile path for gen-1.** The original FuelBand has **no Bluetooth radio** — BLE
  arrived with the SE. The Android app is SE-only (no USB code, no gen-1 device kit) and
  its `Cmd_DesktopData.encode()` throws *"desktop data functionality is not supported"*.
- **No `save`/commit opcode**, no crypto, no local DIN validator, and no host-side
  writer for the `imprinted` bit.
