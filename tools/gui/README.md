# FuelBand Revival — the easy way (no terminal)

A simple app with buttons, for people who'd rather not type commands.

## Why this isn't just a web page

A normal website can't talk to the FuelBand. Browsers can only reach USB devices
that advertise themselves in a particular way, and this band doesn't — which is
why the original Nike software was a desktop app too. So this runs as a small
program on your own computer that shows its screen in your browser. Nothing is
sent over the internet; it only listens to your own machine.

## What you need

**Node.js** — free, from [nodejs.org](https://nodejs.org) (choose the LTS
version). Install it once, then you never need to think about it again.

## How to use it

1. Plug the band into your computer with its USB cable.
2. Double-click **`Start FuelBand Revival.command`** (Mac) or
   **`Start FuelBand Revival.bat`** (Windows).
3. A black window opens — leave it alone — and your browser opens the app.
4. Press **Check band**. It'll tell you, in plain English, whether the band is
   already activated.
5. If it isn't, press **Activate — step 1**, wait for it to finish (the band
   restarts partway through — that's normal), then **Activate — step 2**.
6. Press **Check band** again. It should say the band is activated.
7. Fill in **Your details** — height, weight, age, sex, daily goal — and press
   **Save to band**. The band needs these to work out your fuel properly.
8. **Get your activity out** exports your current fuel, step and calorie
   counters as a spreadsheet you can download.

When you're done, close the browser tab and the black window.

## Apple Health

The export gives you a CSV. Apple won't let a computer write into Health
directly, so the last step happens on your iPhone with a Shortcut — the
instructions are in [`../HEALTH.md`](../HEALTH.md).

Worth knowing before you start: this exports the band's **current totals**, not
a day-by-day history. The band's stored workout history has never been decoded
by anyone, so there's no way to recover past days — only to start collecting
from now on.

## If something goes wrong

- **"Node.js is not installed"** — install it from nodejs.org, then double-click
  the Start file again.
- **"Band not found"** — unplug the band, plug it back in, try again. Try a
  different USB port or cable.
- **"Setup isn't finished"** — close everything and double-click the Start file
  again; it needs one run to install its bits.
- **The browser doesn't open** — look in the black window for a line like
  `http://127.0.0.1:8730` and paste that into your browser.

## A word of caution

This writes settings to your band. It's the same kind of thing Nike's own
software did, and it worked on both of ours, but there's no warranty and you're
experimenting with your own hardware. The **Check band** button only reads and
changes nothing, so start there.

Not affiliated with or endorsed by Nike.
