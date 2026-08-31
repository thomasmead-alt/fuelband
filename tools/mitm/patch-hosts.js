#!/usr/bin/env node
// Repoint Nike+ Connect's API hosts at a local server by patching its embedded
// services config, so the real app talks to our mock with NO DNS spoofing and
// NO certificate trust.
//
// Why this works:
//  * The imprint/API/keryx hostnames live ONLY in an embedded, XOR-obfuscated
//    JSON resource ("production_json_obtxt"). There is no file, env var or
//    preference that overrides it — config.dat is a firmware/device manifest and
//    contains no hostnames at all.
//  * Every endpoint URL in that JSON is built by interpolation
//    ("https://${api-host-name}/v1.0/device/imprint?..."), and NO endpoint has a
//    hardcoded host. So rewriting four host variables redirects 100% of traffic.
//  * The client sets CURLOPT_SSL_VERIFYPEER=0 and CURLOPT_SSL_VERIFYHOST=0, so
//    pointing it at https://127.0.0.1 with a self-signed cert needs no trust
//    step. (The scheme is baked into each URL, so we keep https and let the
//    mock serve TLS — simpler than rewriting every scheme.)
//
// Obfuscation: single repeating 16-byte XOR, key phase 0 aligned to the blob
// start, NUL-terminated blob.
//
// Usage:
//   node patch-hosts.js <path-to-binary> [newHost]      # default 127.0.0.1
//   node patch-hosts.js <path-to-binary> --verify       # decode & print, no write
//
// Writes <binary>.patched and leaves the original untouched. NOTE: modifying the
// binary invalidates its code signature (macOS Gatekeeper / Windows
// Authenticode); on an old Intel Mac you may need to allow it explicitly.

const fs = require("fs");

const KEY = Buffer.from([0x29, 0x9f, 0x60, 0x1a, 0xd2, 0x14, 0x47, 0xc2,
                         0xb2, 0x26, 0xd5, 0xf3, 0xfa, 0x59, 0x9b, 0x4c]);

// Host variables to rewrite. Every endpoint interpolates one of these.
const HOST_KEYS = ["base-host-name", "secure-base-host-name",
                   "api-host-name", "keryx-host-name"];

function xorAt(buf, start, len) {
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = buf[start + i] ^ KEY[i % KEY.length];
  return out;
}

// Find the services JSON by brute-force: try every offset and see whether the
// decode starts with '{' and contains a known key. Cheap enough, and avoids
// depending on a hardcoded offset that differs per build.
function findBlob(buf) {
  const MIN = 2000;   // the services JSON is several KB; reject short false hits
  for (let off = 0; off < buf.length - MIN; off++) {
    // quick reject: the blob starts with '{'
    if ((buf[off] ^ KEY[0]) !== 0x7b) continue;
    // measure to the NUL terminator
    let len = 0;
    while (off + len < buf.length &&
           (buf[off + len] ^ KEY[len % KEY.length]) !== 0x00) len++;
    if (len < MIN) continue;                       // too short to be the JSON
    const text = xorAt(buf, off, len).toString("latin1");
    // must contain the host variables we intend to patch
    if (text.includes("api-host-name") && text.includes("base-host-name")) {
      return { off, len, text };
    }
  }
  return null;
}

function main() {
  const [, , file, arg] = process.argv;
  if (!file) {
    console.error("usage: node patch-hosts.js <binary> [newHost|--verify]");
    process.exit(1);
  }
  const newHost = (!arg || arg === "--verify") ? "127.0.0.1" : arg;
  const buf = fs.readFileSync(file);

  console.log(`scanning ${file} (${buf.length} bytes) for the embedded services JSON...`);
  const found = findBlob(buf);
  if (!found) {
    console.error("Could not locate the services JSON. Is this the main Nike+ Connect binary?");
    process.exit(2);
  }
  console.log(`found at file offset 0x${found.off.toString(16)}, length ${found.len}`);

  let json = found.text;

  console.log("\ncurrent hosts:");
  for (const k of HOST_KEYS) {
    const m = json.match(new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`));
    console.log(`  ${k.padEnd(24)} = ${m ? m[1] : "(not present)"}`);
  }
  if (arg === "--verify") {
    console.log("\n--verify: no changes written.");
    return;
  }

  // Rewrite each host value, PADDING with spaces so total length is unchanged.
  // The blob is NUL-terminated and embedded in the binary; changing its length
  // would shift everything after it.
  let changed = 0;
  for (const k of HOST_KEYS) {
    const re = new RegExp(`("${k}"\\s*:\\s*")([^"]*)(")`);
    const m = json.match(re);
    if (!m) { console.log(`  skip ${k} (absent)`); continue; }
    const oldVal = m[2];
    if (newHost.length > oldVal.length) {
      console.error(`  ERROR: "${newHost}" is longer than "${oldVal}" for ${k}; cannot patch in place.`);
      process.exit(3);
    }
    // Pad OUTSIDE the quotes: JSON permits whitespace between a value and the
    // following comma, and padding inside the string would leave trailing
    // spaces in the hostname and corrupt every interpolated URL.
    const pad = " ".repeat(oldVal.length - newHost.length);
    json = json.replace(re, `$1${newHost}$3${pad}`);
    changed++;
    console.log(`  ${k} : ${oldVal} -> ${newHost}`);
  }
  if (!changed) { console.error("nothing to patch"); process.exit(4); }

  // Re-encode and splice back at the same offset/length.
  const plain = Buffer.from(json, "latin1");
  if (plain.length !== found.len) {
    console.error(`ERROR: length changed (${found.len} -> ${plain.length}); refusing to write.`);
    process.exit(5);
  }
  const out = Buffer.from(buf);
  for (let i = 0; i < plain.length; i++) out[found.off + i] = plain[i] ^ KEY[i % KEY.length];

  const dest = file + ".patched";
  fs.writeFileSync(dest, out);
  console.log(`\nwrote ${dest}`);
  console.log("Replace the original with this (keep a backup), then run the mock server on :443.");
  console.log("The client does not verify certificates, so a self-signed cert is fine.");
  console.log("NOTE: this invalidates the binary's code signature.");
}

main();
