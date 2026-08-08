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

## Config block & save

`option-*` commands (0x32–0x3B) set individual display/profile options; the
`get/set desktop data` commands (0x51/0x52) read and write the whole
`DesktopOptions` config blob (which carries a CRC — see `DesktopOptions.cc`).
A `save` command flushes programmable parameters to flash. Full profile setup
(goal, units, 24-hour, etc.) uses these; minimal wake-up just needs the clock.
