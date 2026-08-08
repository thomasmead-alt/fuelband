# FuelBand USB protocol (extracted from Nike+ Connect)

Reverse-engineered from `FuelBandPlugin.dll` in the Nike+ Connect installer
(`FuelBandCommands.cc` command table + handler disassembly). Opcodes below are
calibrated against known values — `0x13` battery and `0x60` protocol version
match prior community reverse-engineering, and `0x31` (time) was confirmed by
disassembling its handler.

## Transport

The band exposes size-bucketed HID reports (from its descriptor): output IDs
9/10/11/12 (7/15/31/63-byte) and matching input IDs 1/2/3/4, plus feature ID
113. WebHID can't reach these; hidapi (`node-hid`) can. Two framings are used
over `SET_REPORT`/`GET_REPORT`:

- **data family**: write feature on the sized output ID as `[outId, len, opcode, …args]`, read reply on feature ID 4.
- **system family**: write `[0x01, len+1, 0x07, opcode, …args]`, read reply on feature ID 1. (The `0x07` tag; used by the older status/identity commands.)

Response byte 0 typically echoes the opcode. Multi-byte integers in
command payloads are **big-endian**.

## Command opcodes (from the FuelBandCommands.cc table)

| opcode | command |
|--------|---------|
| 0x31 | time (get/set clock) |
| 0x32 | 24-hour mode |
| 0x33 | metric units |
| 0x34 | weight |
| 0x35 | height |
| 0x36 | age |
| 0x3A | gender |
| 0x37 | display loop |
| 0x38 | display orientation |
| 0x39 | display goal options |
| 0x3B / 0x42 | display format / timestamp |
| 0x1A | goal (get/set) |
| 0x25 | fuel (get/set) |
| 0x51 | get desktop data (config block) |
| 0x52 | set desktop data (config block) |
| 0x19 | read memory int |
| 0x13 | battery · 0x60 protocol version · 0x0A network version |

(Identity/status opcodes from prior RE: version 0x08, serial 0xe1, model 0xe0,
hw-rev 0xe2, status 0xdf — used with the system framing.)

## Set clock (the initialization the band waits for)

`doTime` builds, for opcode **0x31**:

```
payload = time(4B, big-endian unix seconds)
        + gmtOffset(4B, big-endian seconds)
        + dstOffsetMinutes(1B)
```

So a full set-clock command body is `31 tt tt tt tt gg gg gg gg dd`. The
`tools/fuelband-dump.js --set-clock` command sends exactly this with the
current time. Setting the clock is what the official app does first on a fresh
band; after that the band starts keeping time and tracking fuel.

## Transport detail: OUTPUT reports

Commands are sent as **output reports** (`HidD_SetOutputReport`), not feature
reports — the DLL's send path sets report type 2. In node-hid that's
`device.write([reportId, …])`. Responses are read with `HidD_GetFeature`
(`device.getFeatureReport`). Feature-writes are tolerated for read-only
queries but state changes must be output reports.

## Config block (`DesktopOptions`) format

Read via `0x51`, written via `0x52`. Binary layout (from `DesktopOptions.cc`
parse at 0x100331F0):

```
[4-byte header][payload …][2-byte CRC, big-endian]
```

- Minimum total length 6. The 4-byte header is **not** covered by the CRC.
- CRC is over the payload bytes only; the stored CRC is the last 2 bytes, big-endian.
- Payload carries the profile/options fields logged by the parser:
  `imprint_state` (u32), goal, birthdate, band name, metric weight, metric
  height, `clock auto set`, `profile_update_date`, plus the display options.

### CRC-16/XMODEM

Confirmed poly `0x1021`, init `0x0000`, MSB-first, no reflection, no final xor
(table at 0x1005c700, update `crc = (crc<<8) ^ table[(crc>>8) ^ byte]`):

```js
function crc16xmodem(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= (b << 8);
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc & 0xffff;
}
```

## Save

`option-*` commands (0x32–0x3B) set individual display/profile options; the
`get/set desktop data` commands (0x51/0x52) read/write the whole config blob
above. A `save` command flushes programmable parameters to flash.

## Initialization status (open)

A factory band shows "connect to USB" until it is **imprinted**. Setting the
clock (0x31) is acknowledged by the band but does not by itself leave that
screen. Imprinting requires writing a valid `DesktopOptions` blob (with
`imprint_state` set and a correct CRC) via `0x52` and issuing `save` — the
remaining reverse-engineering work is reconstructing the exact payload field
layout the app writes (serializer at 0x10032c20).
