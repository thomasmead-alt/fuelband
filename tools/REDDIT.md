# Activating a dead Nike+ FuelBand (gen 1) offline — no servers, no Nike software

Nike shut down Nike+ services and Nike+ Connect on **30 April 2018**. A
first-generation FuelBand that was never set up has been a paperweight ever
since: it powers on, shows a USB prompt, and waits for software that no longer
exists.

**It can now be activated over USB with a single Node script.** No Nike servers,
no Nike+ Connect, no fake server, no certificates. Reproduced on two different
bands (`20M9FC5V01660`, `20M9FC6H01976`), both on firmware **F2.12**, and the
activation survives a power cycle.

As far as I can find, this hadn't been done publicly. Every prior project stops
short of activation — one archived library's own README says it *"never really
made it anywhere in terms of getting info off the fuelband,"* and a 2024 project
has the gen-1 setup function present but left as an empty stub.

---

## The thing that blocked everyone: the `0x07` wrapper

Commands aren't sent bare. Each one is wrapped:

```
out:    [len+1, 0x07, <opcode>, <payload…>]     size-bucketed output report
reply:  feature report 1 -> [01, len, 0x07, …]
```

Send an opcode without it and you get back `01 01 <opcode>` — an empty body.
Nike's own code calls that *"operation not recognized by firmware."* **It's a
trap: it almost always means you framed the request wrongly, not that the command
is missing.** I spent days concluding this firmware "didn't implement" commands
it implements perfectly well.

## The settings record

Persistent settings live in one CRC-checked record ("DesktopOptions"), written
with `0x51` (chunked) and read with `0x50`.

```
[total length: 4 bytes BIG-ENDIAN]
[DIN: 48][UDI: 48][deviceGroupConfigId: 48]      NUL-padded, no length prefix
[TLVs …]
[CRC-16/XMODEM: 2 bytes]
```

TLVs are `[tag u16 BE][len u8][value]`:

| tag | field | type |
|---|---|---|
| `0x01` / `0x02` | metric weight / height | bool, len **1** |
| `0x05` / `0x06` / `0x07` | email / birthdate / screen name | string |
| `0x0b` | **imprint_state** | u32 BE, len **4** |
| `0x0c` / `0x0f` | first name / band name | string |
| `0x0d` | profile_update_date | i64 BE, len **8** |
| `0x0e` | clock auto set | bool, len 1 |

Chunked write, each chunk as the body of `0x51`:
```
[83 a2][flag][off>>16][off>>8][off&0xff][data … ≤53 bytes]
```
`flag` = 0 first / 1 continuation / 2 final. The offset counts **data bytes
only** — the `83 a2` prefix repeats in every chunk. There is **no begin, no
commit, and no flush**; the sequence just ends with a read-back.

## The two things I got wrong for weeks

Both are worth stating, because either one alone silently breaks everything.

**1. String TLVs need a length byte.** I was writing `[tag][bytes][NUL]` instead
of `[tag][len][bytes]`. The parser reads the byte after the tag as a length — so
it took the *first character of the string* as the length and desynchronised from
tag `0x05` onward. Tags `0x06, 0x07, 0x0c, 0x0f, 0x0d` were never parsed at all.
The record still round-tripped perfectly (correct length header, valid CRC),
which is exactly why it took so long to spot.

Also: a known tag with the **wrong length is silently skipped**, not rejected. I
sent `0x01`/`0x02` as u32 instead of bools for months and got no complaint.

**2. `imprint_state` is a 0–100 progress scale, not a small enum.** The real
values:

```
0 Fresh · 3 TimeSet · 5 DinGenerated · 10 SetupComplete
20 InFirstCharge · 30 FirstChargeComplete · 100 Complete
```

I'd been writing 1, 2, 3 — all of which land in the firmware's explicit
*"below 20, do nothing"* branch. Every completion check in the desktop app
compares against **100**.

## What actually activates a band

```sh
node fuelband-dump.js --autoimprint   # corrected record + access token + reboot
node fuelband-dump.js --provision     # goal, metric, gender, 24h, age, clock
node fuelband-dump.js --checklist     # imprinted = 1
```

Status `0xdf` byte 0 bit 0 is the imprinted flag:
```
band 1:  c8 -> cf     band 2:  80 -> c0 -> c7
```
`mode` also advances 0 → 3. Both survived a reboot, so it's persisted in flash.

The requirement appears to be **a correctly-formed settings record plus a written
access token plus a configured profile** — not one magic command. I have not
isolated a single decisive opcode, and I'd rather say that than guess.

## Things I proved wrong along the way

- **The corrected record alone is not enough.** Writing it to a pristine band
  landed cleanly and did nothing.
- **run-state isn't involved.** `[0x28, f1, 29, state]` is rejected on both bands,
  and one activated anyway. My marker payload is evidently wrong.
- **`goalSet` isn't a precondition.** The second band activated with it still 0.
- **The DIN doesn't need to be real.** It's a server-issued UUID, but the firmware
  treats it as an opaque string — there's no checksum, no signature, and **no
  cryptography anywhere in the gen-1 plugin**. A fabricated identity is accepted.
- **The band's own timestamps stay zero** (device-init, assessment-start) even
  after activation — so the "assessment" state machine isn't a gate either.

## Corrections to earlier public work

- The opcode table you'd get by pairing handlers in the registration function is
  **misaligned** — `time` is `0x21`, not `0x31` (`0x31` is 24-hour mode).
- Battery voltage is **big-endian** (`10 5e` = 4190 mV; little-endian gives ~24 V).
- The version string is `sprintf("%c%u.%u", r[0], r[2], r[1])` — major and minor
  are transposed, so `46 0c 02` is `F2.12`.
- `0x1c` is **eeprom-erase**, not restoreDefaults (which is a separate
  fire-and-forget `0x02`). Worth knowing before you sweep anything.

## ⚠️ Don't sweep unknown opcodes

I bricked a band with `0x14` during a blind sweep — display dead, button
unresponsive, no longer enumerating, at 100% charge. It came back after a long
spell on the charger (that class of command is a shipping mode meant to be exited
by USB power), but there was no guarantee. Stick to commands you can name.

Also avoid: `latchup` (disconnects the battery), `restoreDefaults`,
`eeprom-erase`, `bootblock`, and the firmware-flash family.

## Repo

Tools, full protocol notes, and an architecture write-up of the original desktop
software are on GitHub. No Nike binaries, firmware, or credentials are included —
you don't need any of them; the script talks to the band directly.

Corrections welcome. I'd still love a status + settings dump from a band that was
activated back when the servers were running, purely as a reference.
