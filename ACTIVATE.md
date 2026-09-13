# How to activate a Nike+ FuelBand

A dead-simple guide for bringing a **first-generation Nike+ FuelBand** back to
life, years after Nike's servers went away.

If your band powers on, shows a USB or "connect me" prompt, and then does
nothing useful — this is for you. It takes about ten minutes, most of which is
installing one thing.

**No Nike software. No servers. No internet connection. No account.**

---

## First: is this the right band?

This works on the **original FuelBand** — the 2012 model, plain black band,
charges and syncs over a **USB** plug built into the clasp.

| | |
|---|---|
| ✅ **Works** | FuelBand (gen 1) — USB only, no Bluetooth |
| ❌ **Not this** | FuelBand SE — pairs over Bluetooth to a phone |
| ❌ **Not this** | SportBand, SportWatch, Nike+ iPod sensors |

The certain test: plug it into a computer. If it appears as a USB device with ID
**`11ac:6565`**, it's the right one. (Mac: *System Information → USB*. Linux:
`lsusb`. Windows: Device Manager → *Details → Hardware Ids*.)

The SE is a different device with different firmware and is **not** covered here.

## What you need

- The band and its USB cable (or the built-in USB clasp)
- A computer — **macOS or Linux**. Windows probably works but nobody has
  confirmed it yet; if you try it, please say how you got on.
- **Node.js**, free from [nodejs.org](https://nodejs.org) — take the LTS version
- About ten minutes

**Charge the band first.** Give it half an hour on USB before you start. A band
that's been in a drawer since 2015 is flat, and a flat band answers slowly or
not at all — which looks exactly like a failure.

---

## ⚠️ Read this before you start

**This is experimental software operating on hardware that cannot be replaced.**

It has worked on two bands, cleanly, with no ill effects. That is two bands. It
is not a product, it has no warranty, and nobody can fix yours if it goes wrong.

What we can tell you honestly:

- Everything in this guide either **reads** from the band, or sends a command
  **Nike's own software sent**. Nothing here is a blind guess at an unknown
  command.
- There are commands on this device that will wipe it or switch its battery off.
  **The tool deliberately doesn't expose them.** During this project we did brick
  a band with one of them — it came back after a long charge, but there was no
  guarantee it would.
- If something looks wrong, the recovery is: unplug, **hold the band's button for
  about 10 seconds** to force a hardware reset, plug back in, try again.

Start with the read-only check in step 3. It changes nothing, and it tells you
whether you even need to do the rest.

---

## Option A — the app (no terminal)

If typing commands isn't your thing, use this. It's the same tool with buttons
on it, running entirely on your own machine.

1. Install [Node.js](https://nodejs.org) (LTS).
2. Download this project and unzip it.
3. Open the `tools/gui` folder.
4. Double-click **`Start FuelBand Revival.command`** (Mac) or
   **`Start FuelBand Revival.bat`** (Windows).
   - A black window opens. Leave it alone — it's doing the work.
   - Your browser opens the app. If it doesn't, look in the black window for a
     line like `http://127.0.0.1:8730` and paste that into your browser.
5. Plug in the band and press **Check band**.
6. If it says *not activated*, press **Activate — step 1**, wait for it to finish
   (the band restarts partway through — that's normal), then **Activate — step 2**.
7. Press **Check band** again. It should now say activated.
8. Fill in **Your details** — press **Read from band** first to load what's
   already on it, then set your weight, height, age, sex, daily fuel target,
   the clock, and the name you want on the band. Press **Save everything to
   band**.

That's the whole thing. Skip to [Did it work?](#did-it-work).

---

## Option B — the terminal

### 1. Get set up

```sh
cd path/to/fuelband/tools
npm install
```

**Linux only** — you'll need permission to talk to the device. Either run the
commands with `sudo`, or (better) create `/etc/udev/rules.d/99-fuelband.rules`:

```
KERNEL=="hidraw*", ATTRS{idVendor}=="11ac", ATTRS{idProduct}=="6565", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="11ac", ATTRS{idProduct}=="6565", MODE="0666"
```

then `sudo udevadm control --reload-rules && sudo udevadm trigger`, and unplug
and replug the band.

On macOS it just works.

### 2. Check the band first — this changes nothing

```sh
node fuelband-dump.js --checklist
```

You're looking for the `imprinted` line:

- `imprinted = 0` → not activated. Carry on to step 3.
- `imprinted = 1` → **already activated.** You don't need any of this. Skip to
  [Set it up for yourself](#set-it-up-for-yourself).

If it errors instead, see [If something goes wrong](#if-something-goes-wrong).

### 3. Activate it

Two commands, in this order. **Both are needed** — the first gets the band most
of the way, the second finishes it.

```sh
node fuelband-dump.js --autoimprint
```

This writes a correctly-formed settings record and an access token, then reboots
the band and re-reads its status. It takes about a minute, and **the band will
restart partway through — that's expected.** Don't unplug it.

```sh
node fuelband-dump.js --provision
```

This writes the profile: daily goal, units, sex, 12/24-hour clock, age, clock.

```sh
node fuelband-dump.js --checklist
```

### 4. Did it work?

```
imprinted = 1
```

That's it. That's the whole result. The status byte should have moved from
something like `0x80` or `0xc8` to `0xc7` or `0xcf`.

Unplug the band and check it holds — press the button and it should behave like
a set-up band rather than begging for a computer. The setting survives a power
cycle; we verified that on both bands.

---

## Set it up for yourself

The band uses your height, weight, age and sex to work out how much fuel you've
earned, so it's worth filling in. Units are explicit, so nothing is ambiguous:

```sh
node fuelband-dump.js --readprofile          # what's on the band now

node fuelband-dump.js --setprofile \
    --weight 78kg --height 180cm --age 34 --gender M \
    --goal 3000 --metric 1 --24h 1 --clock now
```

- `--weight 78kg` or `--weight 172lb`
- `--height 180cm`, `--height 71in`, or `--height 5ft10`
- `--gender M` or `F` · `--goal` daily fuel target
- `--metric 1|0` (what the band displays) · `--24h 1|0`
- `--clock now` (this computer's time) or `--clock 2026-09-13T14:30`

**Set the clock.** The band has no way to know the date on its own, and it's what
timestamps your activity. `--clock now` is the usual answer.

### Put your own name on it

Separately from the settings above, the band holds a small record with your name
and the band's name in it. Out of the box our activation writes placeholders
(`user`, `Fuel`) — replace them with your own:

```sh
node fuelband-dump.js --readrecord           # what the record holds now

node fuelband-dump.js --writerecord \
    --name Tom --bandname "Tom's Band" \
    --email you@example.com --birthdate 1990-04-12
```

Anything you don't name is carried over from what's already on the band, so
changing one field never blanks the rest — and a band that was activated keeps
its own identity fields.

Every field is read back off the band straight after it's written, so the output
tells you what actually stuck. A value that already matched what you typed shows
as *unchanged* — that's normal.

To get activity off the band afterwards, see
[`tools/HEALTH.md`](tools/HEALTH.md).

---

## If something goes wrong

| What you see | What it means |
|---|---|
| `cannot open device`, `EACCES`, permission denied | Linux permissions — add the udev rule above, or use `sudo`. |
| `no FuelBand found`, `device not found` | Unplug, replug, try another port and another cable. The clasp contacts corrode; clean them. |
| `Cannot find module`, `dlopen`, `NODE_MODULE_VERSION` | Setup didn't finish. Run `npm install` in `tools/` again. |
| Commands time out or answer erratically | Almost always a flat battery. Charge for an hour and retry. |
| `imprinted` still `0` after both commands | Run them again, in order. If it still won't take, unplug, hold the button ~10 s, replug, and start from `--checklist`. |
| Band seems unresponsive | Hold the button ~10 seconds for a hardware reset. If it's completely dead, leave it on a charger for several hours — a deeply discharged band can take a long time to show any sign of life. |

Still stuck? Open an issue and include the full output of:

```sh
node fuelband-dump.js --checklist
node fuelband-dump.js --extrareads
```

Those are both read-only. They contain your band's serial number — scrub it if
you'd rather not post it.

---

## Never run these

The tool doesn't offer them as convenience flags on purpose. Don't go looking for
a way to send them:

- **`latchup`** — disconnects the battery. This is what bricked a band.
- **`restoreDefaults`** — factory wipe
- **`eeprom-erase`** — erases the stored activity
- **`bootblock`** / anything firmware-flash related
- **Blind opcode sweeps** — firing unknown commands at irreplaceable hardware to
  see what happens

Everything in this guide is either a read, or a command Nike's own software sent
in normal use.

---

## What actually happens (the short version)

Nike called first-time setup *imprinting*. Originally it meant: the desktop app
asked Nike's servers for a device identity, bounced you through a web page to
finish setup, and then wrote a settings record to the band over USB.

The servers are gone. But it turns out **the band never needed them** — only the
app did. The device side of that process is a handful of USB commands with no
cryptography in it at all: write an access token, set a run-state, write a
settings record with the setup-progress field at 100, configure a profile. The
firmware then sets its own `imprinted` bit.

So that's what this does. It mints an identity locally, writes the same record,
and the band accepts it.

The reason nobody managed this before appears to be two small traps. A command
sent with the wrong framing returns the *same* reply as a command that doesn't
exist, so people concluded working commands were missing. And the settings
record's parser silently ignores any field with a wrong length — so a nearly
correct record is written, acknowledged, checksummed, and quietly ignored. We
shipped that exact bug ourselves and lost days to it.

Full detail is in [`tools/PROTOCOL.md`](tools/PROTOCOL.md) and
[`tools/NIKE-CONNECT-ARCHITECTURE.md`](tools/NIKE-CONNECT-ARCHITECTURE.md).

---

## Questions people ask

**Do I need Nike+ Connect, or any Nike software?**
No. Don't install it. It can't complete setup any more — that's the whole
problem. This talks to the band directly.

**Do I need an internet connection?**
No. You need it once to install Node.js, and after that you could do this on a
machine that has never been online.

**Do I need a Nike account?**
No. There's nothing to log into.

**Is anything sent anywhere?**
No. Everything runs on your machine. The app in Option A listens on
`127.0.0.1` only — it isn't reachable from your network, let alone the internet.

**Will this brick my band?**
It hasn't on the two it's been run on, and nothing here sends a destructive
command. But it's experimental software on unreplaceable hardware and there's no
warranty. Start with the read-only check.

**Will it sync to my phone / Nike+ / Apple Health?**
Not to Nike+ — that's gone. Not to a phone at all: the gen-1 band has no
Bluetooth. You can export its current counters to a spreadsheet and get those
into Apple Health with a Shortcut — see [`tools/HEALTH.md`](tools/HEALTH.md),
which is honest about the limits (current totals only; the stored workout
history has never been decoded).

**Does it work on the FuelBand SE?**
No. Different device, different firmware, different transport. Nothing here
applies.

**My band is already activated from back in the day. Anything useful here?**
You can still set your profile, read the band, and export counters. And a status
plus settings-record dump from a band that was activated by Nike's own servers
would be a genuinely useful reference — please consider posting one.

---

## If it works, say so

Two bands is a small sample. If you activate one — or if you try and it doesn't
work — please open an issue saying which, with your firmware version (the
`--checklist` output has it). The more bands this is confirmed on, the more
confidently the next person can run it.

*Not affiliated with, endorsed by, or connected to Nike, Inc. "Nike", "Nike+"
and "FuelBand" are trademarks of their respective owner, used here only to
identify the hardware this software works with. The services this replaces were
retired by the vendor in April 2018.*
