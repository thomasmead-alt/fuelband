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
function writeRbrune(dev, cmd) {
  const buf = [0x01, cmd.length + 1, 0x07, ...cmd];
  dev.sendFeatureReport(buf);
  return { outId: 0x01, buf };
}

function tryRead(dev, readId, len = 64) {
  try {
    const r = dev.getFeatureReport(readId, len);
    return { readId, data: r };
  } catch (e) {
    return { readId, error: e.message };
  }
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
    if (!process.argv.includes("--dump")) await probe(dev);
    await dumpMemory(dev);
  } finally {
    dev.close();
  }
  console.log("\nDone. Paste the output above back to Claude.");
})();
