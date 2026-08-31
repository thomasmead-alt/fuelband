# Setting your details, and getting data into Apple Health

Two separate things, and they are not equally solved. Read the honest summary
first so you know what you're getting.

| | State |
|---|---|
| Setting height / weight / age / sex / goal / units | **Works.** The encodings come from the original desktop plugin, and every write is read back. |
| Exporting the band's *current* fuel / step / calorie counters | **Works**, with one caveat below. |
| Exporting a day-by-day or per-workout **history** | **Not possible yet.** The band's sample store has never been decoded publicly, and it isn't decoded here. |
| Writing directly into Apple Health from this tool | **Not possible.** Apple Health can only be written from an app on the iPhone/Watch. The last hop is a Shortcut you run yourself. |

---

## 1. Setting your details

### From the app (no terminal)

Double-click the Start file, open the page, and use **3. Your details**. Fill in
what you know, press **Save to band**. Anything left blank is left alone.

### From the terminal

```sh
cd tools

node fuelband-dump.js --readprofile          # what's on the band now

node fuelband-dump.js --setprofile \
    --weight 78kg --height 180cm --age 34 --gender M \
    --goal 3000 --metric 1 --24h 1
```

Units are explicit, so nothing is ambiguous:

- `--weight 78kg` or `--weight 172lb`
- `--height 180cm`, `--height 71in`, or `--height 5ft10`
- `--age` whole years, `--gender M` or `F`
- `--goal` daily fuel target, `--metric 1|0`, `--24h 1|0`

Every field is read back off the band immediately after it's written, and the
output tells you what actually changed. A value that already matched what you
typed shows as *unchanged* — that's normal, not a failure.

### How the band stores these

Taken from the scaling constants in the original plugin, not guessed:

| Field | Opcode | Wire format |
|---|---|---|
| weight | `0x33` | `u16` = kg × 2.20462262 × 10 → **tenths of a pound** |
| height | `0x34` | `u16` = inches × 4 → **quarter-inches** (cm ÷ 2.54 to convert) |
| age | `0x35` | `u8` years |
| sex | `0x36` | one ASCII char, `'M'` / `'F'` (a factory band reads `'U'`) |
| goal | `0x25` | `[type][goal:3 BE]`, type 0 = current day |
| units | `0x32` | `1` metric, `0` imperial |
| clock | `0x31` | `1` 24-hour, `0` 12-hour |

So the band is imperial internally regardless of what it displays; `0x32` only
changes the display.

---

## 2. Exporting activity

```sh
node fuelband-dump.js --export
```

writes `fuelband-export.json` and `fuelband-export.csv` next to the tool. Or use
**4. Get your activity out** in the app and press the download buttons.

What comes out:

```csv
date,metric,value,unit
2026-08-31T12:00:00.000Z,fuel,1840,fuel
2026-08-31T12:00:00.000Z,steps,6210,count
2026-08-31T12:00:00.000Z,active_energy,412,kcal
```

**Caveat, stated plainly:** fuel (`0x24`) is confirmed. The step and calorie
figures come from `0x2a` and `0x2b`, which are the same three-byte width as fuel
and sit right beside it in the command table — that is strong circumstantial
evidence, not proof. The JSON keeps them under `counterA` / `counterB` as well
so you can check them yourself: walk a known number of steps, export twice, and
see which counter moved by how much. If you confirm or disprove the mapping,
please open an issue.

### What you cannot get

The band keeps a per-sample workout store, reachable in principle through
`0x17` (sample query) and `0x19` (read memory). Its *format* — how samples are
framed, timestamped and scaled — has never been published, and we have not
decoded it. That means **no historical import**: you can export today's running
totals whenever you like, but you cannot go back and recover last Tuesday.

If you want a history, the practical answer is to export on a schedule (a daily
`--export` into a dated file) and build the history going forward.

---

## 3. Getting the CSV into Apple Health

Apple Health has no desktop write path at all — no file import, no API from a
Mac or PC. Anything that claims otherwise is running an app on the phone. So the
last step happens on your iPhone, once, and then it's repeatable.

### The Shortcut route (no coding, no App Store purchase)

1. **Get the file onto the phone.** AirDrop `fuelband-export.csv` to yourself, or
   save it into iCloud Drive / Files.
2. On the iPhone open **Shortcuts** → **+** to create a new shortcut.
3. Add these actions in order:
   - **Get File** — point it at the exported CSV (or use *Select File* to be
     asked each time).
   - **Get Text from Input**
   - **Split Text** — separator **New Lines**
   - **Repeat with Each**
   - Inside the repeat: **Split Text** on the *Repeat Item*, separator **Custom**
     `,` — then **Log Health Sample**, choosing the type (Steps, or Active
     Energy) and taking the value from item 3 of the split, and the date from
     item 1.
4. Run it. iOS will ask permission to write to Health the first time — allow it.

If you'd rather not build that, a simpler version works fine: run the export,
read the two numbers off the screen, and use a one-action shortcut (or Health →
Browse → Steps → Add Data) to type them in. For three numbers a day that is
genuinely faster than automating it.

**Fuel doesn't exist in Health.** There is no NikeFuel type and no sensible
equivalent, so it isn't imported — it stays in the CSV and JSON. Steps and
active energy are the two that map onto real Health types.

### Android / anything else

The JSON is plain and stable; feed it to whatever you like. Health Connect on
Android accepts writes from any app, so a small companion app is a much shorter
road there than on iOS.

---

## Safety

Everything on this page is either a read or one of the profile setters the
original desktop software itself sent. None of it touches the destructive
commands listed in the main [README](../README.md#-safety).
