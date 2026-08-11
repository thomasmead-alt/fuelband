# Reviving the Nike+ FuelBand: the USB *write* protocol, and the wrapper byte everyone missed

Nike shut down the Nike+ services and Nike+ Connect on 30 April 2018. A
first-generation FuelBand that was never set up is now a paperweight: it boots to
a "connect to USB" prompt and waits for software that no longer exists.

I've been reverse-engineering the USB protocol from Nike's own `FuelBandPlugin.dll`
(the installer is an NSIS archive of native DLLs, and the DLL still carries its
C++ source filenames and log format strings — `FuelBandCommands.cc`,
`DesktopOptions.cc`), verified against two physical bands.

## Prior art

- **rbrune/fuelband-usb** — Python, reads status/serial/firmware/logs over USB HID.
  Explicitly notes activity data readout is unsupported.
- **openyou/libfuelband** — archived 2018. The author's own summary: *"This library
  never really made it anywhere in terms of getting info off the fuelband."*
- **evilsocket** — reversed the FuelBand **SE**'s BLE protocol, and found that an
  all-`FF` auth token works.

So publicly: some reads on gen-1 over USB, nothing that writes, and a separate
BLE story for the SE.

## What's new

**1. The `0x07` command wrapper.** This is the whole ballgame. Commands aren't
sent bare — they're wrapped:

```
body  = [len+1, 0x07, <opcode>, <payload…>]   as an OUTPUT report, size-bucketed
reply = feature report 1 -> [01, len, 0x07, …]
```

Send an opcode without it and you get `01 01 <opcode>` — an empty body. Nike's own
code calls that *"operation not recognized by firmware"*, which is exactly why
it's so misleading: **it usually means you addressed the device wrong, not that
the command is missing.** I burned a long time concluding this firmware "didn't
implement" commands it implements perfectly well.

**2. Writes work.** Verified byte-exact by reading each value back:

| command | opcode | payload |
|---|---|---|
| clock | `0x21` | `[unix:4 BE][gmtOffset:4 BE][dstMinutes:1]` |
| goal | `0x25` | `[type:1][goal:3 BE]` |
| 24-hour | `0x31` | `[bool:1]` |

A band whose factory clock read Jan 2000 is now keeping real time — confirmed by
reading it back 274 seconds later and seeing it advance.

**3. The chunked config transfer**, reconstructed from `0x100386f0` and confirmed
against hardware. Each chunk, as the body of opcode `0x51`:

```
[83 a2] [flag] [off>>16] [off>>8] [off&0xff] [data …]
```

`flag` = 0 first / 1 continuation / 2 final (the rewrite to 2 is guarded, so a
single-chunk transfer stays 0). Data budget `0x3c - 6 - 1` = **53 bytes**. All
transfer state is host-side — no BEGIN, no handshake, no finalize. The band acks
each chunk with the running offset: `01 05 07 00 <offset:3>`.

**4. The config blob format.**

```
[total length: 4 bytes BIG-ENDIAN] [payload] [CRC-16: 2 bytes]
```

Those leading four bytes are a length, not padding — a zero header fails the
parser's `len >= 6` check and the blob is silently discarded. CRC is
**CRC-16/XMODEM** (poly `0x1021`, init `0`), table at `0x1005c700`, verified
against the canonical `"123456789"` → `0x31c3`.

**5. Corrections to things that were wrong.** The opcode table you'd get by
pairing handlers in the registration function is *misaligned* — `time` is `0x21`,
not `0x31` (`0x31` is 24-hour mode). Battery voltage is big-endian (`10 5e` =
4190 mV; little-endian gives ~24 V). The version string is
`sprintf("%c%u.%u", r[0], r[2], r[1])` — major and minor are transposed relative
to the obvious reading, so `46 0c 02` is `F2.12`.

**6. From the Android APK — why the all-`FF` token works.** The `DIN` is a
server-issued **UUID**, stored per-serial, and it *is* the BLE auth key:

```java
key = MD5( DIN_as_16_bytes  XOR  b37ebf75c6c71924a3b1884a29704435 )
```

When no DIN is known the app falls back to sixteen `0xFF` bytes and logs
`Using legacy auth token`. So the published all-`FF` result isn't a flaw found
from outside — it's Nike's own no-DIN fallback path. (Also: the mobile client
*cannot* write desktop data at all — `Cmd_DesktopData.encode()` throws
`"desktop data functionality is not supported"`.)

## What's still blocked

Activation. The band stays un-imprinted (status `0xdf`, bit 0) no matter what we
write. The config blob's first three fields are `DIN`, `UDI` and
`device group config id` — 48 bytes each, all **Nike account-issued**. Writing a
well-formed blob with empty identifiers commits to the region but doesn't flip the
bit. `doRunState` (`0x28`) is rejected even with the payload derived exactly from
the DLL. It's possible no fabricated blob will ever satisfy the firmware.

## ⚠️ Warning: don't sweep unknown opcodes

I ran a blind opcode sweep and **bricked a band with `0x14`**. It doesn't appear
anywhere in Nike's DLL. The write itself timed out mid-transaction, the display
died, the button stopped responding and it no longer enumerates — consistent with
`latchup` ("turn off battery", which is in Nike's command list). It was at 100%
charge at the time. Latchup is a shipping mode and is meant to be exited by USB
power, so it may yet come back, but don't repeat my mistake: `0x13` is `battery`,
and whatever sits next to it is not worth finding out by hand.

Full protocol notes, an annotated disassembly of the transfer routine, and a
`node-hid` tool are in the repo. Corrections very welcome — particularly from
anyone with a **provisioned** band, since a single `0xdf` status dump and a config
region read from a working unit would answer the activation question outright.
