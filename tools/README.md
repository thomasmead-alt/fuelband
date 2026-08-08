# FuelBand native tool

The in-browser app can connect to the original FuelBand over WebHID and read
its report layout, but it **cannot read data back**: this band answers only on
raw `GET_REPORT`/`SET_REPORT` control transfers using report IDs 9–12, and
WebHID refuses feature transfers on any report ID the descriptor doesn't
declare (only 113 here, which itself won't read). That's a browser security
limit, not a band problem.

This tool talks to the band with **hidapi** (via `node-hid`), which has no such
restriction — the same mechanism the original `libfuelband` and
`rbrune/fuelband-usb` projects used.

## Run it

```sh
cd tools
npm install
node fuelband-dump.js
```

- `npm install` pulls `node-hid` (prebuilt binaries; no compiler needed on
  Windows/macOS). On **Linux** you may need libusb/hidraw dev packages, e.g.
  `sudo apt install libusb-1.0-0` and a udev rule granting access to
  `11ac:6565`.
- On **Linux** you may need to run with `sudo` (or add the udev rule) so the
  process can open the device.

## What it does

1. **Probes** the band with several command framings (libfuelband's
   write-feature-on-9–12 / read-feature-on-4, rbrune's `01 len 07 …`, and async
   input reports) and prints every reply as hex.
2. **Dumps** the "desktop data" memory block (`bb 50 37 36 …`) and writes it to
   `fuelband-dump.bin`, printing the payload hex.

Paste the output back and we use it to (a) confirm which framing the band
answers on, and (b) locate the fuel/steps field by matching a number read off
the band's display against the dumped bytes. Once the offset is known, the web
app can decode and display it.

`node fuelband-dump.js --dump` skips the probes and goes straight to a dump.

## Finding the fuel value

Once you can read a number off the band's display (fuel or steps), search for
it directly:

```sh
node fuelband-dump.js --find 2417
```

This reads the identity, pages the account region (`43 19`), reads the
desktop-data block, and reports any offset where that number appears as a
2/3/4-byte little- or big-endian value. A hit pins down where the fuel field
lives; from there the reader can be locked in.

## Initializing a fresh band (set the clock)

A factory/reset band shows a "connect to USB" screen and won't track fuel until
its clock is set — the job the discontinued Nike+ Connect app did. That exact
command was extracted from the app (see `PROTOCOL.md`): opcode `0x31` with a
big-endian time, GMT offset, and DST minutes. To send it with your current
time:

```sh
node fuelband-dump.js --set-clock
```

It reads the clock, writes the current time, re-reads to verify, and tells you
to check whether the band left the setup screen. This writes to the band, but
it's the same benign command the official app used, and the band's hardware
reset (hold the button ~10s until RESET flashes) restores factory state if
anything looks off.
