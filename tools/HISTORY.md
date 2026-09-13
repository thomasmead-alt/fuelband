# Decoding the historic data

**Status: unsolved, and this is the plan to solve it.**

The band records your activity as it happens and keeps it in an internal sample
store. Nobody has publicly decoded that store's format — every prior project
lists it as unsupported, and we haven't cracked it either. What follows is a
method, some tooling, and an honest account of what we know and don't.

You now have something no previous attempt had: **a working, activated band that
is accumulating real data**, and a tool that can read it. That turns this from
guesswork into an experiment.

---

## Why this is hard, and why it's tractable

Hard: we have no documentation, the format is binary, and the band's own
software that would have parsed it is gone. Guessing a record layout from a
single dump is close to hopeless.

Tractable: formats like this fall **differentially**. You don't decode a dump —
you decode the *difference* between two dumps taken around a known quantity of
real-world activity. If you walk 2,000 steps and a number in the store goes up
by 2,000, you've found the steps field. Do that a few times and the record
falls out.

Everything below is **read-only**. Nothing writes to the band.

---

## Start here: find where the store lives

Before any of the differential work, there is one targeted thing to try, and it
comes from a pattern hiding in plain sight. Both region reads we already know
have the **same shape**:

```
   [opcode] 0x37 [selector] [offset:3 BE]
     0x50    0x37    0x36      ...           -> the settings record
     0x52    0x37   <bank>     ...           -> internal flash banks 1..6
```

`0x37` is a constant marker; the byte after it **selects what you get back**.
And we have only ever sent one selector — `0x36` — to the `0x50` getter.

```sh
node fuelband-dump.js --findstore
```

This sweeps that selector across `0x00`–`0xff` using `0x50`, the read-only
getter the tool already uses on every run. It is one parameter varied on a known
safe call, not a blind sweep of unknown opcodes. Selector `0x36` acts as a
**positive control**: it must come back with the settings record. If the control
doesn't answer, the sweep isn't working and a lack of other hits proves nothing.

Anything else that returns real data is a candidate for the sample store. Feed
it into the snapshots:

```sh
node fuelband-dump.js --snapshot before --sel 0x55,0x56
```

> `0x50` is the getter. `0x51` is the *setter* — the sweep deliberately does not
> touch it.

---

## The method

### 1. Take a baseline snapshot

```sh
cd tools
node fuelband-dump.js --snapshot morning
```

This captures, into a timestamped JSON file:

- wall-clock time, the band's own clock, battery
- the fuel counter (`0x24`) and the two suspected step/calorie counters
  (`0x2a`, `0x2b`)
- the `0x17` sample-query reply — 21 bytes of zeros on a factory band, and the
  most likely home for a store header
- internal flash banks 1–6 (`0x52`)
- the settings record, plus any selectors you pass with `--sel`

### 2. Go and do something

Wear the band. Walk. The more activity the better — a clear, large delta is far
easier to spot than a small one. **Note roughly what you did**: how long, and if
you can, a step count from your phone for the same period.

Half a day is ideal. An hour of deliberate walking works.

### 3. Take a second snapshot

```sh
node fuelband-dump.js --snapshot evening
```

### 4. Compare them

```sh
node fuelband-dump.js --compare snapshot-morning-*.json snapshot-evening-*.json
```

This runs entirely offline — no band needed, so you can do it later, or send
both JSON files to someone else to analyse.

It reports:

- **Which counters moved, and by how much.** If fuel didn't move, the band
  recorded nothing and there's no point looking further.
- **Which regions changed**, where, and in how many runs.
- **Timestamp-shaped values** — any 4-byte big-endian number that lands in the
  window between your two snapshots. In an unknown binary format, finding the
  timestamps is most of the battle.
- **The record size**, inferred from the spacing between those timestamps, and
  **the sampling interval**, inferred from the gaps between their values.

On synthetic test data with 12-byte records every 10 minutes, it recovers all
three correctly from nothing but the two dumps.

---

## What to look for in the output

**"NOTHING changed anywhere"** — either the band genuinely recorded nothing
(check the fuel counter), or the store is somewhere we aren't reading. That's a
real possibility; see the open questions below.

**A region that grew** — excellent. Append-only storage is the easiest kind.
The new bytes at the end are the records written while you were walking.

**Evenly spaced timestamps** — the jackpot. The spacing is the record size, and
you can then slice the region into records and line the fields up in columns.

**Your fuel delta appearing in the data** — if fuel moved by 42 and you find a
42, or a running total that ends at the new fuel figure, that's the fuel field
identified.

Once you have record size and a timestamp offset, the remaining fields usually
give themselves up: they're small integers that only increase, and there are
only a handful of plausible interpretations (fuel, steps, calories, an activity
intensity, a sequence number).

---

## What we actually know so far

| | |
|---|---|
| `0x17` | "sample query". Returned **21 bytes of zeros plus a live timestamp** on a factory-blank band — consistent with an empty-store header. Never seen non-empty. |
| `0x19` | "read memory int", takes a 3-byte address. Reads *something*; we have never established the address space or where the samples sit in it. |
| `0x52 0x37 <bank>` | Internal flash banks. 1/2 are an A/B pair holding the serial; 3/4 an A/B pair holding the goal; 5 reads zeros; 6 is the fault log; 7–15 unsupported. **None of these looked like a sample store**, but they were read on blank bands. |
| `0x51 <region:3> <off:3>` | Region read. `50 37 36` (ASCII `P76`) is the settings record. Other region codes are unexplored — the store may well be one of them. |
| `0x1c` | **eeprom-erase. Never send this.** It erases the sample store, which is the thing we're trying to read. |

The honest summary: we know *three different mechanisms* that can read memory,
and we don't know which one reaches the samples. The snapshot captures all
three so the comparison can tell us.

## Open questions

1. **Does `0x17` become non-empty on a worn band?** Untested — we only ever read
   it on blank ones. This is the cheapest thing to check and might answer
   everything on its own.
2. **Does `0x17` take parameters?** It's called "sample *query*". A query with no
   arguments is odd. It may want a start time, an index, or a count.
3. **Which selector holds the store?** `0x36` is the settings record. An earlier
   draft of this document guessed at region *names* (`P77`, `S76`); that was a
   misreading — `50 37 36` is opcode + marker + selector, not a three-character
   name. `--findstore` sweeps the selector properly.
4. **Where in the `0x19` address space do samples live?** A sweep is slow but
   would settle it. `--snapshot <label> --mem <start-hex> <length-hex>` includes
   one if you want to try.

## If you crack it

Please open an issue with the record layout and, if you can, the two snapshot
files that show it. This is the last significant unsolved piece of the gen-1
FuelBand, and it's the difference between exporting today's totals and
recovering a history.

---

## Safety

Everything in this document is a **read**. The one command that must never be
sent is `0x1c` (eeprom-erase), and the tool does not expose it. See the main
[README](../README.md#-safety) for the full do-not-send list.
