# Runbook — what to type

Everything runs from the `tools/` directory with the band connected by USB.

```sh
cd tools
npm install        # first time only (pulls node-hid)
```

If the tool can't open the device, it's a permissions problem: on Linux add a udev
rule for `11ac:6565` or use `sudo`. On macOS it should just work.

---

## Step 1 — Read-only diagnostics (do these first)

None of these change anything on the band. Run them in this order and keep the
output; between them they probe every surface we know about.

```sh
node fuelband-dump.js --extrareads
```
Reads run-state, both timestamps, assessment-metrics and the fault log.
Both timestamps read zero on a blank band — and, as it turns out, **they stay
zero even after a successful activation**, so they are not a precondition. Useful
as a baseline; not a blocker.

```sh
node fuelband-dump.js --sysreserved
```
Sweeps system-reserved fields 0–15 (`0`=BAND_COLOR, `1`=USB serial enumeration
method, `2`=version, `3–15`=raw reserved). We previously sent field 64 by
mistake, so no valid field has ever actually been read.
**Watch for:** any line marked `<DATA>`.

```sh
node fuelband-dump.js --membanks
```
Sweeps internal flash banks 0–15. Nike's own software only ever reads bank
`0x06` (the fault log). Banks 1–4 are A/B slot pairs holding the firmware's own
config (serial, goal) with incrementing sequence counters; 7–15 are unsupported.
**Watch for:** `<DATA>` on any bank other than `0x06`.

```sh
node fuelband-dump.js --echotest
```
Writes a deliberately non-canonical but parseable settings record and diffs the
read-back. Nike's own writer normalises, so:
- **read-back normalised** → the firmware genuinely parses the record; contents matter.
- **read-back byte-identical** → it's an opaque blob store, and the imprint bit is
  *not* gated on record contents at all. That would tell us to stop polishing it.

```sh
node fuelband-dump.js --checklist        # decode the status byte
node fuelband-dump.js --getdesktop       # what the firmware reports as its settings record
```

---

## Step 2 — The activation attempt

This writes to the band. It's recoverable (the hardware reset is hold-button ~10 s),
and every command it sends is one Nike's own software sends.

```sh
node fuelband-dump.js --autoimprint     # corrected record + access token + reboot
node fuelband-dump.js --provision       # profile: goal, metric, gender, 24h, age, clock
node fuelband-dump.js --checklist       # imprinted = 1
```

**Both commands are needed.** `--autoimprint` alone took a pristine band from
`0x80` to `0xc0`; `--provision` completed it to `0xc7` (imprinted). The
requirement appears to be a correctly-formed record **plus** a written access
token **plus** a configured profile — not one magic command.

`--autoimprint` runs the corrected sequence, then power-cycles and re-checks:
run-state `0x12` → both timestamp reads → the full `DesktopOptions` record with
`imprint_state = 100` → option-age → read-back → clock → reboot → re-read status.

**Watch for:** `*** IMPRINTED ***`, or the final `imprinted` line in the checklist.

What makes this work, where earlier attempts didn't: the string TLVs carry their
length byte, `imprint_state` is 100 (earlier values sat in the firmware's
"below 20, do nothing" branch), `0x01`/`0x02` are bools, and `0x0e` is present.
Any one of those wrong and the record is silently mis-parsed while still
round-tripping with a valid CRC.

If you'd rather step through it manually:
```sh
node fuelband-dump.js --fullimprint     # write, no reboot
node fuelband-dump.js --reset           # power-cycle over USB
#   wait ~15 s for it to re-enumerate
node fuelband-dump.js --checklist       # read imprinted on the fresh boot
```

Diagnostics, if it doesn't take:
```sh
node fuelband-dump.js --canonical --reset   # full record + reboot
node fuelband-dump.js --idfuzz              # identity sweep (numeric DIN, all-FF legacy, …)
node fuelband-dump.js --minimize            # drop one TLV at a time
node fuelband-dump.js --token               # access-token write (0x40), never sent by anyone
```

---

## Step 3 — Make it yours, and get data back out

Once `imprinted = 1`, set the profile the band uses to calculate fuel. Units are
explicit, so nothing is ambiguous (`78kg`/`172lb`, `180cm`/`71in`/`5ft10`).

```sh
node fuelband-dump.js --readprofile          # what's on the band right now

node fuelband-dump.js --setprofile \
    --weight 78kg --height 180cm --age 34 --gender M \
    --goal 3000 --metric 1 --24h 1
```

Every field is read back after writing, and the output says what changed. A
field that already matched shows as *unchanged* — that is not a failure.

Export the current counters:

```sh
node fuelband-dump.js --export               # → fuelband-export.{json,csv}
```

This is **current totals only** — fuel, plus the two counters believed to be
steps and calories. The band's per-workout sample store is not decoded, so there
is no historical export. Full detail, plus the Apple Health route, is in
[`HEALTH.md`](HEALTH.md).

---

## Step 4 — The fake-server route (NOT REQUIRED)

> Activation does not need this. Both bands were activated with Steps 1–2 alone.
> Kept only as reference for the retired web API.

The strongest remaining play: let Nike's **own** app do the imprint, against a
server we control. Needs a pre-Catalina Intel Mac, because Nike+ Connect is a
32-bit `i386` app that won't launch on 10.15+.

```sh
cd tools/mitm
sh gen-certs.sh
```

**Repoint the app at localhost** — no DNS spoofing, no keychain trust needed,
because the client does no certificate validation at all:

```sh
cp "/Applications/Nike+ Connect.app/Contents/MacOS/Nike+ Connect" ~/nc-backup

node patch-hosts.js "/Applications/Nike+ Connect.app/Contents/MacOS/Nike+ Connect" --verify
node patch-hosts.js "/Applications/Nike+ Connect.app/Contents/MacOS/Nike+ Connect"

mv "/Applications/Nike+ Connect.app/Contents/MacOS/Nike+ Connect.patched" \
   "/Applications/Nike+ Connect.app/Contents/MacOS/Nike+ Connect"
```

Then run the mock and the app:
```sh
sudo node nike-mock-server.js      # needs root for :443; logs to mitm-log.txt
```
Launch Nike+ Connect with the band plugged in and walk the setup screens. Watch
`mitm-log.txt` — it records every request, so if the app stalls we can see which
response it didn't like and fix that handler.

Then check the band:
```sh
cd ..
node fuelband-dump.js --checklist
node fuelband-dump.js --getdesktop
```

**Reading the outcome:**
- `imprinted = 1` → solved.
- `imprinted = 0` but `--getdesktop` shows the DIN the mock minted → the app wrote
  our identity and the firmware still refused it. That's the definitive wall, and
  it isolates the cause precisely.
- App never reaches the write → a mock response is wrong; the log shows which.

Patching invalidates the code signature. On pre-Catalina that's usually fine; if
Gatekeeper objects, `xattr -cr` the `.app`. Keep the backup.

---

## Do not run

`0x1c` eeprom-erase, `send 0x02` restoreDefaults, `send 0x03` latchup (turns the
battery off — this is what bricked a band once; it recovered on a charger),
`send 0x04` bootblock, and the firmware-flash family. The tool does not expose
these as convenience flags on purpose. `--surface` (the blind opcode sweep) is
also best left alone.
