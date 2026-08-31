# FuelBand Revival

Tools and protocol documentation for the **first-generation Nike+ FuelBand**
(USB `11ac:6565`), so owners can keep using hardware they already own after the
manufacturer's services shut down in April 2018.

**Status: a factory-blank band can be activated over USB, with no servers.**
Reproduced on two different bands. As far as we can find, this hadn't been done
publicly before — every prior project stopped short of activation.

---

## What this does

A gen-1 FuelBand that was never set up is inert: it powers on, shows a USB
prompt, and waits for software that no longer exists. This project:

- **Talks to the band over USB** — identity, firmware, battery, status, settings.
- **Writes settings** — clock, daily goal, profile, display options.
- **Activates a blank band** ("imprinting"), which previously required Nike's
  now-dead servers. **No servers or Nike software are involved** — the script
  talks to the band directly over USB.
- **Documents the protocol** so others don't have to redo the work.

## Requirements

- Node.js
- A gen-1 Nike+ FuelBand and a USB cable
- macOS or Linux (on Linux you may need a udev rule for `11ac:6565`, or `sudo`)

> The browser can't do this: WebHID only permits transfers on report IDs the
> descriptor declares — here just one that won't read — so a native HID library
> is required.

## Quick start

```sh
cd tools
npm install

node fuelband-dump.js --checklist     # read status, decode the imprinted bit
node fuelband-dump.js --extrareads    # timestamps, assessment metrics, fault log
```

To activate a blank band, see **[`tools/RUNBOOK.md`](tools/RUNBOOK.md)**. The
short version:

```sh
node fuelband-dump.js --autoimprint   # corrected settings record + token + reboot
node fuelband-dump.js --provision     # profile: goal, metric, gender, 24h, clock
node fuelband-dump.js --checklist     # imprinted = 1
```

## Documentation

| File | What's in it |
|---|---|
| [`tools/PROTOCOL.md`](tools/PROTOCOL.md) | The USB wire protocol, settings-record format, activation findings |
| [`tools/NIKE-CONNECT-ARCHITECTURE.md`](tools/NIKE-CONNECT-ARCHITECTURE.md) | How the original desktop software is built |
| [`tools/RUNBOOK.md`](tools/RUNBOOK.md) | Ordered, copy-pasteable commands |
| [`tools/mitm/`](tools/mitm/) | *Not required for activation.* Reference notes on the retired web API |

## ⚠️ Safety

**Some commands can brick your band.** We bricked one during this work (it
recovered after a long charge, but there was no guarantee). Specifically, do not
send:

- `latchup` — disconnects the battery
- `restoreDefaults` — factory wipe
- `eeprom-erase` — erases the sample store
- `bootblock` / firmware-flash commands
- blind opcode sweeps against unknown commands

The tool deliberately does not expose these as convenience flags. Everything in
the runbook is either read-only or a command the original software itself sent.

There is no warranty. You are experimenting on your own hardware at your own
risk. Start with the read-only commands.

## Scope and legal notes

*Not legal advice — this is a description of what this project does and doesn't
contain. If it matters to you, talk to a lawyer.*

- **No Nike software is distributed here.** No binaries, installers, firmware
  images, or extracted resources. If a workflow needs the original application,
  you supply your own copy.
- **This is interoperability work.** The purpose is to let owners keep using
  hardware they bought, after the vendor discontinued the service it depended
  on. Protocol details are *facts about an interface*, documented in prose.
- **No copy protection is circumvented.** There is none to circumvent: the
  device firmware implements no authentication, encryption, or access control on
  the USB interface.
- **No credentials are published.** API keys and similar values found while
  analysing the original software are deliberately not reproduced.
- **No verbatim disassembly** of third-party binaries is included.
- **Not affiliated with, endorsed by, or connected to Nike, Inc.** "Nike",
  "Nike+" and "FuelBand" are trademarks of their respective owner and are used
  here only to identify the hardware this software interoperates with.
- The services this replaces were **retired by the vendor in April 2018**. This
  project does not interact with, bypass, or impersonate any live service.

Our code is MIT licensed — see [`LICENSE`](LICENSE).

## Contributing

Corrections very welcome, especially from anyone with a band that was activated
back when the servers were running — a status and settings-record dump from one
would still be a useful reference.

Please don't open pull requests containing vendor binaries, extracted resources,
firmware images, or credentials; they won't be merged.
