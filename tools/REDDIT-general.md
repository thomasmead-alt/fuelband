# I got a dead Nike+ FuelBand talking again — and found the one byte that everyone was missing

If you've got a Nike+ FuelBand in a drawer, it's probably a paperweight. Nike
switched off the Nike+ services in April 2018, along with the "Nike+ Connect"
desktop software the band needed. A band that was never set up is stuck: it powers
on, shows a little USB symbol, and waits forever for software that no longer
exists.

I had two, both brand new in the box, and wanted to see how far they could be
brought back.

## The approach

The old Nike+ Connect installer is still floating around, so I pulled it apart and
worked backwards through the code that used to talk to the band. Handily, Nike
shipped it with a lot of internal debug text left in, which makes it much easier
to follow than a typical black box.

Then it was a matter of trying to speak the same language to a real band over USB.

## The thing that was blocking everyone

For a long stretch I could *read* from the band — serial number, firmware, battery,
that sort of thing — but every attempt to change anything got a polite "command not
recognised" style response back. Existing hobbyist projects hit the same wall; one
of them is archived on GitHub with the author's own note that it *"never really
made it anywhere in terms of getting info off the fuelband."*

It turned out the band doesn't accept commands on their own. Each one has to be
wrapped in a small envelope first — literally one extra marker byte in front. Miss
it and the band replies with what looks exactly like "I don't support that," which
is why it's such a good trap. It doesn't mean the feature is missing. It means you
knocked on the wrong door.

Once that was sorted, things that had failed for days started working immediately.

## What works now

- **Setting the clock.** One band's factory clock read January 2000. It now keeps
  real time — I set it, waited, read it back, and it had ticked forward correctly.
- **Setting the daily fuel goal and 12/24-hour display.** Both stick.
- **Writing to the band's configuration storage**, and reading it back byte for
  byte to prove it landed.

Plus a pile of smaller corrections — the battery voltage and firmware version were
being decoded wrongly by earlier work, which is why you'd see nonsense like a
30-volt battery.

## What's still stuck

Activation. The band won't fully "wake up" and start tracking until it's been
registered, and registration needs an ID that only Nike's servers ever handed out.
I can write a perfectly well-formed registration record, and the band accepts and
stores it — but it still doesn't consider itself activated. That may simply not be
solvable without the original servers.

So: a band that keeps time and holds settings, but not yet a working fitness
tracker.

## A warning, since I learned it the hard way

Don't go poking at commands you can't identify. I ran a scan across unknown
command numbers and **killed one of the two bands** — screen dead, button does
nothing, computer no longer sees it at all. It was fully charged at the time. My
best guess is I hit an internal "disconnect the battery" command, which is
recoverable in principle by leaving it on a charger, but it hasn't come back yet.

If you're experimenting with your own, stick to commands you can actually name.

## If you can help

The single most useful thing right now would be a couple of readings from a
FuelBand that **was** set up back in the day. That would show exactly what an
activated band looks like internally, and would likely answer the last question
outright.

Notes, tooling and full technical write-up are on GitHub — corrections very
welcome.
