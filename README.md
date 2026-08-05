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

## Project layout

| File | Purpose |
|------|---------|
| `index.html` | App shell and layout |
| `styles.css` | Dark, LED-inspired theme |
| `app.js` | State, fuel math, rendering, and the weekly SVG chart |
