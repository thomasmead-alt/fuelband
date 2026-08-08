#!/usr/bin/env node
/* Native FuelBand probe + dump using node-hid (hidapi).
 *
 * WebHID refuses the GET_REPORT/SET_REPORT transfers this band needs (it only
 * allows the one declared feature report, id 113, which won't even read).
 * hidapi has no such restriction, so it can talk to the band the way the
 * original tools (libfuelband, rbrune/fuelband-usb) did.
 *
 * libfuelband's proven pattern: WRITE a feature report on the size-bucketed
 * output id (9/10/11/12) framed as [id, length, ...cmd], and READ the reply as
 * a feature report on input id 4. This script tries that plus a couple of
 * other framings, prints every reply as hex, and — if a read returns data —
 * dumps the "desktop data" memory block.
 *
 * Usage:
 *   cd tools && npm install && node fuelband-dump.js
 *   node fuelband-dump.js --dump      # skip probes, go straight to a mem dump
 */

let HID;
try {
  HID = require("node-hid");
} catch {
  console.error("node-hid is not installed. Run:  cd tools && npm install");
  process.exit(1);
}

const VID = 0x11ac;
const PID = 0x6565;

const hex = (a) => Array.from(a).map((x) => x.toString(16).padStart(2, "0")).join(" ");
const ascii = (a) => Array.from(a).map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : ".")).join("");
const isEmpty = (a) => !a || a.length === 0 || a.every((x) => x === 0);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Size-bucketed output report ids: [dataBytes, outputId]
const BUCKETS = [[7, 9], [15, 10], [31, 11], [63, 12]];
function bucket(bodyLen) {
  return BUCKETS.find((b) => bodyLen <= b[0]) || BUCKETS[BUCKETS.length - 1];
}

function openDevice() {
  const devs = HID.devices().filter((d) => d.vendorId === VID && d.productId === PID);
  if (!devs.length) {
    console.error("FuelBand (11ac:6565) not found. HID devices seen:");
    for (const d of HID.devices()) {
      console.error(`  ${d.vendorId.toString(16).padStart(4, "0")}:${d.productId.toString(16).padStart(4, "0")}  ${d.product || ""}`);
    }
    process.exit(1);
  }
  console.log(`Found: ${devs[0].product || "FuelBand"}  path=${devs[0].path}`);
  return new HID.HID(devs[0].path);
}

// --- Framings -------------------------------------------------------------

// libfuelband: write feature [outId, len, ...cmd] padded to bucket, read feature id.
function writeLibfuelband(dev, cmd) {
  const [size, outId] = bucket(cmd.length + 1);
  const body = [cmd.length, ...cmd];
  const buf = [outId, ...body, ...new Array(size - body.length).fill(0)];
  dev.sendFeatureReport(buf);
  return { outId, buf };
}

// rbrune: write feature [0x01, len+1, 0x07, ...cmd], read feature id 1.
// Only valid for SHORT commands (fits report id 1's 7 bytes).
function writeRbrune(dev, cmd) {
  const buf = [0x01, cmd.length + 1, 0x07, ...cmd];
  dev.sendFeatureReport(buf);
  return { outId: 0x01, buf };
}

// System family, bucket-aware: frame [len+1, 0x07, ...cmd] and write it on the
// smallest OUTPUT report that fits, so longer 07-tagged commands (like the
// 13-byte set-clock) aren't truncated onto the 7-byte report id 1.
function writeSystem(dev, cmd) {
  const body = [cmd.length + 1, 0x07, ...cmd];
  const [size, outId] = bucket(body.length);
  const buf = [outId, ...body, ...new Array(Math.max(0, size - body.length)).fill(0)];
  dev.sendFeatureReport(buf);
  return { outId, buf };
}

function tryRead(dev, readId, len = 64) {
  try {
    const r = dev.getFeatureReport(readId, len);
    return { readId, data: r };
  } catch (e) {
    return { readId, error: e.message };
  }
}

// High-level readers built on the two framings that this band answers on.
// System family (version/serial): rbrune framing, tag 0x07, reply on feat#1.
async function readSystem(dev, cmd) {
  writeRbrune(dev, cmd);
  await delay(40);
  const r = tryRead(dev, 1);
  if (r.error || !r.data) return null;
  return r.data.slice(3); // strip [reportId, len, 0x07]
}
// Data family (account/memory): libfuelband framing, reply on feat#4.
async function readData(dev, cmd) {
  writeLibfuelband(dev, cmd);
  await delay(40);
  const r = tryRead(dev, 4);
  if (r.error || !r.data) return null;
  return r.data; // raw: [reportId, len, opcode, ...header, ...data]
}

async function identity(dev) {
  console.log("\n=== IDENTITY ===");
  const ver = await readSystem(dev, [0x08]);
  const ser = await readSystem(dev, [0xe1]);
  if (ver) console.log(`firmware: ${ascii(ver).replace(/\.+$/,"")}  (${hex(ver)})`);
  if (ser) console.log(`serial:   ${ascii(ser)}`);
}

function decodeTs(d) {
  if (!d || d.length < 4) return "";
  const t = (d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24)) >>> 0;
  if (!t || t === 0xffffffff) return "unset";
  try { return new Date(t * 1000).toISOString(); } catch { return `raw ${t}`; }
}

const beU32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

// The Nike app sends commands as OUTPUT reports (HidD_SetOutputReport), not
// feature reports — confirmed by disassembly. node-hid's device.write() does
// exactly that (buf[0] = report id). State-changing commands (set clock, etc.)
// only commit when sent this way; feature-writes are only tolerated for reads.
const padTo = (arr, n) => arr.concat(new Array(Math.max(0, n - arr.length)).fill(0));
function frameSys(cmd) {  // 07-tagged system framing, bucket-aware
  const body = [cmd.length + 1, 0x07, ...cmd];
  const [size, outId] = bucket(body.length);
  return [outId, ...padTo(body, size)];
}
function frameData(cmd) { // plain data framing, bucket-aware
  const body = [cmd.length, ...cmd];
  const [size, outId] = bucket(body.length);
  return [outId, ...padTo(body, size)];
}
function outWrite(dev, buf) { dev.write(buf); } // output report

// CRC-16/XMODEM (poly 0x1021, init 0) — the config-block CRC.
function crc16xmodem(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= (b << 8);
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc & 0xffff;
}

// Read the config block via 0x51 (get desktop data). Tries a no-arg read and a
// paged read (offset like the memory dump), dumping raw replies so we can see
// the real DesktopOptions blob and its framing.
async function readConfig(dev) {
  console.log("\n=== READ CONFIG (0x51 get desktop data) ===");
  // No-arg, both framings, as output reports.
  for (const [name, frame] of [["data", frameData([0x51])], ["07", frameSys([0x51])]]) {
    outWrite(dev, frame);
    await delay(100);
    const r4 = tryRead(dev, 4), r1 = tryRead(dev, 1);
    console.log(`0x51 no-arg (${name}): feat#4[${r4.error ? r4.error : hex(r4.data)}] feat#1[${r1.error ? r1.error : hex(r1.data)}]`);
  }
  // Paged read with a 3-byte offset (mem-dump style).
  console.log("paged (0x51 + offset):");
  const all = [];
  let offset = 0;
  for (let i = 0; i < 24; i++) {
    const off = [(offset >> 16) & 0xff, (offset >> 8) & 0xff, offset & 0xff];
    outWrite(dev, frameData([0x51, ...off]));
    await delay(70);
    const r = tryRead(dev, 4);
    if (r.error || !r.data) { console.log(`  @${offset}: ${r.error || "no data"}`); break; }
    console.log(`  @${offset}: ${hex(r.data)}`);
    const len = r.data[1];
    if (!r.data.length || r.data.length < 7) break;
    for (let j = 7; j < r.data.length; j++) all.push(r.data[j]);
    if (len !== 0x3d) break;
    offset += 0x37;
  }
  if (all.length) console.log(`assembled ${all.length} bytes: ${hex(all)}`);
}

// SET CLOCK — reproduces the official app's doTime (FuelBandCommands.cc):
// opcode 0x31, payload = time(4B big-endian unix) + gmtOffset(4B big-endian
// seconds) + dstOffsetMinutes(1B). This is the initialization the band waits
// for. Reads the clock first, writes it, then re-reads to verify. Safe/
// recoverable: the band's hardware reset (hold button ~10s) restores factory.
async function setClock(dev) {
  const now = Math.floor(Date.now() / 1000);           // UTC seconds
  const offMin = -new Date().getTimezoneOffset();      // local offset (incl DST), minutes
  const gmt = (offMin * 60) >>> 0;                     // seconds, as unsigned 32-bit
  const payload = [0x31, ...beU32(now), ...beU32(gmt), 0x00];
  console.log("\n=== SET CLOCK (opcode 0x31) ===");
  console.log(`local time = ${new Date(now * 1000).toString()}`);
  console.log(`payload    = ${hex(payload)}  (time=${now}, gmtOffset=${offMin * 60}s)`);

  const readClock = async () => {
    const d = await readData(dev, [0x31]);   // data-family read
    const s = await readSystem(dev, [0x31]); // system-family read
    return { d, s };
  };

  const decode = (label, d) => {
    if (!d) return;
    for (let off = 1; off + 4 <= d.length; off++) {
      const t = ((d[off] << 24) | (d[off + 1] << 16) | (d[off + 2] << 8) | d[off + 3]) >>> 0;
      if (t > 1500000000 && t < 2000000000) console.log(`  -> ${label} decoded time @${off}: ${new Date(t * 1000).toString()}`);
    }
  };

  let before = await readClock();
  console.log(`clock before: sys[${before.s ? hex(before.s) : "-"}] data[${before.d ? hex(before.d) : "-"}]`);

  // Send the clock command as an OUTPUT report (how the app does it). Try the
  // 07-tagged framing first, then the plain framing if nothing changes.
  const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
  for (const [name, frame] of [["07-tagged", frameSys(payload)], ["plain", frameData(payload)]]) {
    console.log(`writing clock as OUTPUT report (${name}): ${hex(frame)}`);
    outWrite(dev, frame);
    await delay(120);
    const r1 = tryRead(dev, 1), r4 = tryRead(dev, 4);
    console.log(`  reply feat#1: ${r1.error ? "err " + r1.error : hex(r1.data)}`);
    console.log(`  reply feat#4: ${r4.error ? "err " + r4.error : hex(r4.data)}`);
    await delay(150);
    const after = await readClock();
    console.log(`  clock after: sys[${after.s ? hex(after.s) : "-"}] data[${after.d ? hex(after.d) : "-"}]`);
    decode("sys", after.s); decode("data", after.d);
    if (changed(before.s, after.s) || changed(before.d, after.d)) {
      console.log(`  *** clock CHANGED with ${name} output-report framing ***`);
      break;
    }
  }
  console.log("\nNow LOOK AT THE BAND: did it leave the 'connect to USB' screen / show a time?");
}

// Read a command through BOTH working framings and show what each returns.
async function readBoth(dev, cmd) {
  const s = await readSystem(dev, cmd);   // system family (07-tagged), reply feat#1
  const d = await readData(dev, cmd);     // data family, reply feat#4
  return { s, d: d ? d.slice(3) : null }; // strip [id,len,op] from data reply
}

// Read-only baseline: everything we can learn about the band's current state
// before attempting any writes. Purely reads — safe to run repeatedly.
async function recon(dev) {
  console.log("\n=== RECON (read-only baseline) ===");
  await identity(dev);

  const READS = {
    "protocol 60": [0x60],
    "network 06": [0x06],
    "status df": [0xdf],
    "battery 13": [0x13],
    "model e0": [0xe0],
    "hw-rev e2": [0xe2],
    "init-ts 42 01": [0x42, 0x01],
    "assess-ts 42 02": [0x42, 0x02],
    "fuelreset-ts 42 03": [0x42, 0x03],
    "goalreset-ts 42 04": [0x42, 0x04],
  };
  console.log("\nfield: system-reply | data-reply");
  for (const [name, cmd] of Object.entries(READS)) {
    const { s, d } = await readBoth(dev, cmd);
    const tsNote = cmd[0] === 0x42 ? `  ts(sys)=${decodeTs(s)} ts(data)=${decodeTs(d)}` : "";
    console.log(`  ${name.padEnd(16)}: sys[${s ? hex(s) : "-"}] | data[${d ? hex(d) : "-"}]${tsNote}`);
  }

  console.log("\naccount region (43 19), paged:");
  const acct = await readAccountRegion(dev);
  console.log("  bytes:", hex(acct) || "(none)");
}

// Read the 0x43 0x19 account region, paging by 0x37 until a short reply.
async function readAccountRegion(dev) {
  const collected = [];
  for (let offset = 0, i = 0; i < 32; i++) {
    const off = [(offset >> 16) & 0xff, (offset >> 8) & 0xff, offset & 0xff];
    const r = await readData(dev, [0x43, 0x19, ...off]);
    if (!r || r.length < 3) break;
    const len = r[1];
    console.log(`  43/19 @${offset}: ${hex(r)}`);
    for (let j = 3; j < r.length; j++) collected.push(r[j]);
    if (len !== 0x3d) break; // 0x3d = full chunk -> more data
    offset += 0x37;
  }
  return collected;
}

// Scan a byte buffer for a number as 2/3/4-byte little- and big-endian.
function scanValue(label, buf, target) {
  const hits = [];
  const le = (o, w) => { let v = 0; for (let k = 0; k < w; k++) v |= buf[o + k] << (8 * k); return v >>> 0; };
  const be = (o, w) => { let v = 0; for (let k = 0; k < w; k++) v = (v << 8) | buf[o + k]; return v >>> 0; };
  for (let o = 0; o < buf.length; o++) {
    for (const w of [2, 3, 4]) {
      if (o + w > buf.length) continue;
      if (le(o, w) === target) hits.push(`${label}[${o}] ${w}B LE`);
      if (be(o, w) === target) hits.push(`${label}[${o}] ${w}B BE`);
    }
  }
  return hits;
}

async function find(dev, target) {
  console.log(`\n=== FIND ${target} ===`);
  await identity(dev);
  console.log("\naccount region (43 19):");
  const account = await readAccountRegion(dev);
  console.log("\ndesktop-data (bb 50 37 36):");
  const mem = [];
  for (let offset = 0, i = 0; i < 8; i++) {
    const off = [(offset >> 16) & 0xff, (offset >> 8) & 0xff, offset & 0xff];
    const r = await readData(dev, [0xbb, 0x50, 0x37, 0x36, ...off]);
    if (!r) break;
    for (let j = 7; j < r.length; j++) mem.push(r[j]);
    if (r[1] !== 0x3d) break;
    offset += 0x37;
  }
  const hits = [
    ...scanValue("account", account, target),
    ...scanValue("memory", mem, target),
  ];
  console.log("\nmatches:", hits.length ? hits.join(", ") : "none");
  console.log("account bytes:", hex(account) || "(none)");
}

// --- Probe ----------------------------------------------------------------

const PROBE_CMDS = [
  { name: "version", cmd: [0x08] },
  { name: "serial", cmd: [0xe1] },
  { name: "account 43 19", cmd: [0x43, 0x19, 0x00, 0x00, 0x00] },
  { name: "mem-read bb 50 37 36", cmd: [0xbb, 0x50, 0x37, 0x36, 0x00, 0x00, 0x00] },
];
const READ_IDS = [4, 3, 2, 1, 113];

async function probe(dev) {
  console.log("\n=== PROBE: libfuelband framing (write feature outId, read feature id) ===");
  for (const { name, cmd } of PROBE_CMDS) {
    try {
      const { outId, buf } = writeLibfuelband(dev, cmd);
      console.log(`\n${name}: wrote feat#${outId} [${hex(buf)}]`);
      await delay(40);
      for (const rid of READ_IDS) {
        const r = tryRead(dev, rid);
        if (r.error) console.log(`  read feat#${rid}: — ${r.error}`);
        else console.log(`  read feat#${rid}: ${hex(r.data)}  "${ascii(r.data)}"${isEmpty(r.data) ? "  (empty)" : "  <-- DATA"}`);
      }
    } catch (e) {
      console.log(`\n${name}: write failed — ${e.message}`);
    }
  }

  console.log("\n=== PROBE: rbrune framing (write feat#1 [01 len 07 ...], read feat#1) ===");
  for (const { name, cmd } of PROBE_CMDS) {
    try {
      const { buf } = writeRbrune(dev, cmd);
      console.log(`\n${name}: wrote [${hex(buf)}]`);
      await delay(40);
      const r = tryRead(dev, 0x01);
      if (r.error) console.log(`  read feat#1: — ${r.error}`);
      else console.log(`  read feat#1: ${hex(r.data)}  "${ascii(r.data)}"${isEmpty(r.data) ? "  (empty)" : "  <-- DATA"}`);
    } catch (e) {
      console.log(`\n${name}: write failed — ${e.message}`);
    }
  }

  console.log("\n=== PROBE: async input reports (write output, listen for 'data') ===");
  await new Promise((resolve) => {
    let got = false;
    const onData = (data) => { got = true; console.log(`  input event: ${hex(data)}  "${ascii(data)}"`); };
    dev.on("data", onData);
    try {
      const [size, outId] = bucket(8);
      const body = [7, 0xbb, 0x50, 0x37, 0x36, 0x00, 0x00, 0x00];
      dev.write([outId, ...body, ...new Array(size - body.length).fill(0)]);
    } catch (e) {
      console.log(`  write failed — ${e.message}`);
    }
    setTimeout(() => { dev.removeListener("data", onData); if (!got) console.log("  (no input events in 1.5s)"); resolve(); }, 1500);
  });
}

// --- Dump -----------------------------------------------------------------

async function dumpMemory(dev, maxBytes = 320) {
  console.log("\n=== MEM DUMP (libfuelband framing, read feat#4) ===");
  const out = [];
  let offset = 0;
  for (let i = 0; i < 32 && out.length < maxBytes; i++) {
    const off = [(offset >> 16) & 0xff, (offset >> 8) & 0xff, offset & 0xff];
    writeLibfuelband(dev, [0xbb, 0x50, 0x37, 0x36, ...off]);
    await delay(50);
    const r = tryRead(dev, 4);
    if (r.error) { console.log(`chunk ${i}: read error — ${r.error}`); break; }
    console.log(`chunk ${i} @${offset}: ${hex(r.data)}`);
    if (isEmpty(r.data)) break;
    // r.data = [readId?, status, off, off, off, ...payload]; keep raw for now.
    for (let j = 6; j < r.data.length; j++) out.push(r.data[j]);
    offset += 0x37;
  }
  if (out.length) {
    const fs = require("fs");
    fs.writeFileSync("fuelband-dump.bin", Buffer.from(out));
    console.log(`\nWrote ${out.length} bytes to tools/fuelband-dump.bin`);
    console.log("Payload hex:\n" + hex(out));
  } else {
    console.log("No payload captured.");
  }
}

// --- Main -----------------------------------------------------------------

(async () => {
  const dev = openDevice();
  dev.on("error", (e) => console.error("device error:", e.message));
  try {
    const findIdx = process.argv.indexOf("--find");
    if (process.argv.includes("--read-config")) {
      await identity(dev);
      await readConfig(dev);
    } else if (process.argv.includes("--set-clock")) {
      await identity(dev);
      await setClock(dev);
    } else if (process.argv.includes("--recon")) {
      await recon(dev);
    } else if (findIdx !== -1) {
      const target = Number(process.argv[findIdx + 1]);
      if (!Number.isFinite(target)) { console.error("Usage: node fuelband-dump.js --find <number>"); }
      else await find(dev, target);
    } else if (process.argv.includes("--dump")) {
      await identity(dev);
      await dumpMemory(dev);
    } else {
      await identity(dev);
      await probe(dev);
      await dumpMemory(dev);
    }
  } finally {
    dev.close();
  }
  console.log("\nDone. Paste the output above back to Claude.");
})();
