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
