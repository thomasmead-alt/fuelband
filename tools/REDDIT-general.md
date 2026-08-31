# I brought a dead Nike+ FuelBand back to life — 8 years after Nike switched off the servers

If you've got an original Nike+ FuelBand in a drawer, it's probably a paperweight.
Nike shut down the Nike+ services in April 2018, along with the "Nike+ Connect"
desktop software the band needed to be set up. A band that was never activated is
stuck forever: it powers on, shows a little USB symbol, and waits for software
that no longer exists.

I had two, both brand new in the box. **Both are now working.**

## What was actually wrong

The band won't do anything until it's been "activated" — a one-time setup that
originally required Nike's servers to hand it an ID. Those servers are gone, so
the conventional wisdom was that an unactivated band could never be revived.

That turns out not to be true. The band doesn't check with anyone. It just needs
to be told the right things, in the right format, over USB.

## How it went

The old Nike+ Connect installer is still floating around, so I took it apart and
worked backwards through the code that used to talk to the band. Handily, Nike
left a lot of internal debug text in it, which makes it far easier to follow than
a typical black box.

Then it was a matter of learning to speak the same language to a real band.

**The first wall** was that the band appeared to reject almost everything. It
turned out commands have to be wrapped in a small envelope — one extra marker
byte in front. Miss it and the band replies with something that looks exactly
like *"I don't support that."* It's a perfect trap: it doesn't mean the feature is
missing, it means you knocked on the wrong door.

**The second wall** was subtler, and entirely my own fault. I was writing the
band's settings record in a format that was *almost* right — I'd left out a
single length marker in front of each piece of text. The band stored it happily,
handed it back perfectly, and the checksum passed. But internally it was reading
one character of a name as a "how long is this?" number, and everything after
that point turned to noise. Weeks of "the data is clearly fine, why won't this
work" had a one-byte answer.

**The third** was that I'd misread a number. A field I'd assumed was a simple
on/off setting is actually a **progress percentage, 0 to 100.** I'd been writing
1, 2 and 3 — all of which the band reads as *"setup is barely started, ignore
this."* The value it wants is 100.

Fix all three and it activates.

## Where it stands

Both bands are activated, and it survives being unplugged and rebooted — so it's
written into the band permanently, not a temporary trick. The second band proved
it wasn't a fluke.

It needs **nothing but a small script and a USB cable.** No Nike software, no
servers, no accounts, no internet.

## A warning, because I learned it the hard way

Don't go poking at commands you can't identify. Early on I ran a scan across
unknown command numbers and **killed one of the two bands** — screen dead, button
unresponsive, computer couldn't see it at all, and it was fully charged at the
time. I'd hit something like an internal "disconnect the battery" instruction.

It did eventually come back after a long spell on the charger. But for a couple of
days I thought I'd destroyed it, and I got lucky. If you experiment with your own,
stick to commands you can actually name.

## If you've got one

The tools and full technical notes are on GitHub. It's free, there's no Nike
software involved, and it doesn't touch any Nike service — those are long gone.
It's just a way for people to use hardware they already own.

Corrections very welcome, especially from anyone who still has a FuelBand that
*was* set up back in the day — a reading from one would be a useful reference.
