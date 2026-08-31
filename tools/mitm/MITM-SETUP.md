> **NOT REQUIRED — kept for reference only.**
>
> Activation does **not** need any of this. Both of our bands were activated
> using `fuelband-dump.js` over USB alone: no Nike+ Connect, no fake server, no
> DNS changes, no certificates, no patched binary. See
> [`../RUNBOOK.md`](../RUNBOOK.md).
>
> This directory documents the retired web API and a local stand-in for it. It is
> kept because the reverse-engineering findings are worth recording, and because
> it may help anyone building a companion service for syncing. It is not part of
> the activation path, and you should not need to patch any binary.

# Imprinting via a fake Nike server (old Intel Mac)

Goal: run the **real** Nike+ Connect desktop app against a Nike API **we
control**, hand the band a DIN/UDI/tokens **we mint**, and see whether the
firmware imprints. If it does, activation is solved over USB with no live Nike
servers. If it doesn't, the firmware validates identity locally and only a
firmware dump can go further.

## Why this can work / why it might not

The band has **no network** — USB only. So any identity check the firmware does
is **local**, leaving two outcomes:

- **Firmware trusts what the app writes** → it imprints with our identity. (And
  it explains why our hand-built blob failed: the app does a step we missed.)
- **Firmware verifies a signed DIN against a baked-in key** → our unsigned,
  server-minted DIN fails too. Hard wall; needs a firmware dump.

Either way this is decisive, and it also produces the ground-truth imprint you
can compare against our tool.

## Prerequisites

- **Intel Mac running pre-Catalina macOS** (10.13 High Sierra / 10.14 Mojave).
  Required because Nike+ Connect is a 32-bit `i386` app and won't launch on
  10.15+.
- Nike+ Connect installed (from the same installer we've been analyzing).
- Node.js, `openssl`, and this repo (for the `fuelband-dump.js` checker).
- The FuelBand plugged in via USB.

## Steps

### 1. Certs
```sh
cd tools/mitm
sh gen-certs.sh
```
Produces `ca.crt`, `server.key`, `server.crt`.

### EASIEST ROUTE: patch the app's hosts (no DNS, no cert trust)

The API hostnames live in one XOR-obfuscated blob inside the binary, every
endpoint URL is built by `${host}` interpolation (no endpoint hardcodes a host),
and the client does **no certificate validation**. So repointing four strings at
`127.0.0.1` redirects 100% of the traffic with no DNS spoofing and no keychain
work:

```sh
cp "/Applications/Nike+ Connect.app/Contents/MacOS/Nike+ Connect" ~/nc-backup
node patch-hosts.js "/Applications/Nike+ Connect.app/Contents/MacOS/Nike+ Connect" --verify   # show current hosts
node patch-hosts.js "/Applications/Nike+ Connect.app/Contents/MacOS/Nike+ Connect"            # writes .patched
mv "/Applications/Nike+ Connect.app/Contents/MacOS/Nike+ Connect.patched" \
   "/Applications/Nike+ Connect.app/Contents/MacOS/Nike+ Connect"
```
Verified surgical on the 2014 build: 78 bytes changed, all inside the config
blob, only the four host lines. Size is unchanged (padding goes outside the JSON
strings so hostnames stay clean).

Caveat: this invalidates the code signature. On pre-Catalina that is usually
fine; if Gatekeeper objects, `xattr -cr` the .app or allow it in Security
settings. Keep the backup.

Then just run the mock server (steps 1 and 4) — you can skip the hosts file and
the keychain entirely. **Note:** `config.dat` does NOT work for this — it is the
firmware/device manifest and contains no hostnames at all.

### 2. Trust the CA — only needed for the BROWSER leg
**The app itself does no certificate checking at all.** Disassembly of
`HttpRequest.cc` shows it calls `curl_easy_setopt` with
`CURLOPT_SSL_VERIFYPEER = 0` and `CURLOPT_SSL_VERIFYHOST = 0`, and ships no CA
bundle. So any self-signed cert works for the API traffic.

Trust is required only for the setup page, which opens in the system browser:
```sh
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain ca.crt
```
(`gen-certs.sh` issues the leaf for 397 days — Safari rejects leaf certs with
lifetimes over 825 days.)

### 3. Redirect Nike's hosts to your machine
Only `secure-nikeplus.nike.com` appears in cleartext in the binary; the rest of
the service URLs live in an obfuscated embedded resource. So **wildcard the
whole zone** rather than guessing hostnames. With dnsmasq:
```
address=/nike.com/127.0.0.1
address=/nikeplus.com/127.0.0.1
```
then point macOS DNS at `127.0.0.1` (System Preferences → Network → DNS).

`/etc/hosts` works too but cannot wildcard, so start with these and add any host
the log shows going missing:
```
127.0.0.1  secure-nikeplus.nike.com
127.0.0.1  nikeplus.nike.com
127.0.0.1  www.nikeplus.com
127.0.0.1  api.nike.com
```
Flush DNS: `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`.

**Alternative that catches everything:** the client honours the system proxy
(`HttpSettings-osx.cc` / `ProxyResolver.dylib`), so setting a system-wide
HTTP/HTTPS proxy to the mock catches every host regardless of DNS.

### 4. Start the mock server
```sh
sudo node nike-mock-server.js
```
It listens on 443/80, prints the identity it will hand out, and logs every
request to `mitm-log.txt`.

### 5. Run the app and imprint
Launch Nike+ Connect with the band connected. Walk the setup/imprint screens.
Watch `mitm-log.txt` — you'll see the exact endpoints and payloads the app
requests. If the app rejects a response (parse error, retry), tighten the
matching handler in `nike-mock-server.js` (the `respond()` heuristics) using the
logged path/body, and re-run.

### 6. Check the band — the verdict
After the app reports done (or after each attempt), in another terminal:
```sh
cd ..            # tools/
node fuelband-dump.js --checklist
node fuelband-dump.js --getdesktop     # does the band now hold OUR minted DIN?
```
- `imprinted = 1` → **solved.** The band is activated with our identity.
- `imprinted = 0` but `--getdesktop` shows our DIN → the app wrote our identity
  and the firmware still refused it → **local identity validation** (the wall).
- App never reaches the write → a server response is still wrong; fix from the
  log and retry.

## Iterating

The first run mostly teaches us the real endpoints. Expect 2–3 passes:
1. Run → read `mitm-log.txt` → see the true paths/JSON shapes.
2. Tighten `respond()` so the app accepts each step and advances.
3. Once it reaches the USB imprint write, check the band.

## Gotchas

- **Cert verification.** The app uses OpenSSL. If it ships its own CA bundle and
  ignores the system keychain, trusting `ca.crt` won't be enough — point its
  bundle at `ca.crt` (look for a `curl-ca-bundle.crt` / `cacert.pem` inside the
  app bundle and add our CA to it), or use `mitmproxy` transparently instead.
- **Cert pinning.** If a request still fails TLS after trust, the app may pin.
  2014-era builds usually don't, but the log will show a connection that opens
  then drops.
- **Port 443 needs root** → `sudo node ...`.
- Keep the minted identity from the server output; you'll want to diff the
  band's stored DIN against it afterward.
