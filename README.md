# Fuelband

A daily activity tracker inspired by the classic fuel-point fitness bands.
Log activities, earn **fuel points** toward a daily goal, and keep a streak
alive — all in a single dependency-free web app.

## Features

- **Fuel ring** — today's fuel vs. your daily goal, with an animated progress ring
- **Activity logging** — walking, running, cycling, swimming, gym, yoga, team
  sports, and dancing, with light/moderate/intense intensity levels
- **MET-based scoring** — fuel points, calories, and step estimates are derived
  from each activity's metabolic equivalent (MET) and duration
- **Daily stats** — steps, calories, active minutes, and goal streak
- **Weekly chart** — the last 7 days of fuel with a goal line, hover tooltips,
  and an accessible table view
- **Editable goal** — set your own daily fuel target
- **USB device connection** — plug in a first-generation Nike+ FuelBand and
  read its model, serial, firmware, battery, and status over WebHID
- **Local-only data** — everything persists in `localStorage`; nothing leaves
  the device

## Running it

No build step and no dependencies — it's plain HTML/CSS/JS:

```sh
# any static server works, e.g.
python3 -m http.server 8000
# then open http://localhost:8000
```

Or just open `index.html` directly in a browser.

## How fuel is calculated

```
fuel     = METs × intensity factor × minutes × 4
calories = METs × intensity factor × 3.5 × 70 kg / 200 × minutes
```

Intensity factors: light 0.75 · moderate 1.0 · intense 1.3.

## Connecting a real FuelBand (USB)

The **Device** card connects to a first-generation Nike+ FuelBand
(vendor `0x11ac`, product `0x6565`) plugged in over USB, using the
community reverse-engineered HID feature-report protocol from
[rbrune/fuelband-usb](https://github.com/rbrune/fuelband-usb). It reads
model, serial number, firmware version, hardware revision, battery level
and charging state, status flags, and setup/reset timestamps.

Requirements and limits:

- **WebHID** — Chrome or Edge on desktop, served over https or `localhost`
  (the button explains itself if either is missing).
- **Linux** needs a udev rule so the browser can open the hidraw node, e.g.
  `SUBSYSTEM=="hidraw", ATTRS{idVendor}=="11ac", MODE="0666"` in
  `/etc/udev/rules.d/99-fuelband.rules`.
- **No activity sync.** Nike shut down the FuelBand services in 2018, and the
  part of the USB protocol that carries fuel/step data was never reverse-
  engineered — only status reads are documented. Activity entries in the app
  stay manual. (The FuelBand **SE** talks BLE, not this USB protocol, and its
  sessions are encrypted with device-specific keys.)

## Project layout

| File | Purpose |
|------|---------|
| `index.html` | App shell and layout |
| `styles.css` | Dark, LED-inspired theme |
| `app.js` | State, fuel math, rendering, and the weekly SVG chart |
| `fuelband-usb.js` | WebHID connection to a first-gen FuelBand |
