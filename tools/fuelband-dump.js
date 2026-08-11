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

// Read status (0xdf) and decode the "imprinted" flag. Per the DLL's
// completeStatus, imprinted = bit 0 of status byte 0. This is the readable
// feedback signal for whether an imprint attempt worked.
async function readStatus(dev) {
  console.log("\n=== STATUS (0xdf) — imprinted flag ===");
  const s = await readSystem(dev, [0xdf]);   // system framing (like version)
  const d = await readData(dev, [0xdf]);     // data framing
  console.log(`status sys : ${s ? hex(s) : "-"}`);
  console.log(`status data: ${d ? hex(d) : "-"}`);
  const cand = [];
  if (s && s.length) cand.push(["sys byte0", s[0]]);
  if (d && d.length >= 3) cand.push(["data byte@3", d[3] ?? d[2]]);
  for (const [where, b] of cand) {
    if (b === undefined) continue;
    console.log(`  ${where}=0x${b.toString(16).padStart(2, "0")}  imprinted(bit0)=${b & 1}  full-bits=${b.toString(2).padStart(8, "0")}`);
  }
  console.log("(bit 0 == 1 means the band considers itself imprinted)");
}

// CRC-16/XMODEM (poly 0x1021, init 0) — the config-block CRC.
function crc16xmodem(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= (b << 8);
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc & 0xffff;
}

// Build a best-effort DesktopOptions config blob:
//   [4-byte header=0][DIN 48][UDI 48][device-group-config-id 48][imprint_state TLV][CRC-16 BE]
// CRC-16/XMODEM over the payload (everything after the 4-byte header, excluding CRC).
function buildConfigBlob(imprintState, opts = {}) {
  const payload = [];
  const field = (n) => { for (let i = 0; i < n; i++) payload.push(0); };
  field(48); field(48); field(48);                 // DIN, UDI, device group config id (empty)
  // imprint_state: tag 0x000b, len 4, value big-endian
  payload.push(0x00, 0x0b, 0x04,
    (imprintState >>> 24) & 0xff, (imprintState >>> 16) & 0xff, (imprintState >>> 8) & 0xff, imprintState & 0xff);
  if (opts.clockAutoSet !== undefined) payload.push(0x00, 0x0e, 0x01, opts.clockAutoSet & 0xff);
  // Header is a big-endian 32-bit TOTAL length, not padding. Parser at
  // 0x100331F0: len = BE32(data[0..3]); require len >= 6 and len <= received;
  // then ptr += 4, payload_len = len - 6, CRC-16 over those payload bytes,
  // compared against the trailing 2 bytes. So total = 4 + payload + 2 = len.
  const total = payload.length + 6;
  const crc = crc16xmodem(payload);
  return [(total >>> 24) & 0xff, (total >>> 16) & 0xff, (total >>> 8) & 0xff, total & 0xff,
          ...payload, (crc >> 8) & 0xff, crc & 0xff];
}

// Chunked set-desktop-data write (opcode 0x51). Data stream = [0x83,0xa2] + blob.
// Each chunk: [0x51, moreFlag, offHi, offMid, offLo, ...<=55 data], data-family
// framed as an output report; reply read on feat#4.
async function writeDesktopData(dev, blob, verbose = false) {
  const stream = [0x83, 0xa2, ...blob];
  const acks = [];
  let offset = 0;
  while (offset < stream.length) {
    const moreFlag = offset > 0 ? 1 : 0;
    const header = [moreFlag, (offset >> 16) & 0xff, (offset >> 8) & 0xff, offset & 0xff];
    const chunk = stream.slice(offset, offset + 55);
    const cmd = [0x51, ...header, ...chunk];
    outWrite(dev, frameData(cmd));
    await delay(70);
    const r = tryRead(dev, 4);
    acks.push(r.error ? r.error : hex(r.data));
    if (verbose) console.log(`    chunk @${offset} (${chunk.length}B) ack: ${r.error || hex(r.data)}`);
    offset += chunk.length;
  }
  return acks;
}

// Broad memory sweep of the desktop-data partition: page the 0xbb 50 37 36
// read far past what we read before, flagging any bytes that aren't 0xFF (i.e.,
// a stored/factory blob we can copy). Read-only.
async function memSweep(dev, maxBytes = 32768) {
  console.log("\n=== MEMORY SWEEP (0xbb 50 37 36, looking for non-FF) ===");
  const all = [];
  let offset = 0, iters = 0, nonFF = 0;
  while (all.length < maxBytes && iters < 700) {
    const off = [(offset >> 16) & 0xff, (offset >> 8) & 0xff, offset & 0xff];
    const r = await readData(dev, [0xbb, 0x50, 0x37, 0x36, ...off]);
    if (!r || r.length < 8) { console.log(`stopped @${offset}: short/no reply (${r ? hex(r) : "none"})`); break; }
    const status = r[3];
    const data = Array.prototype.slice.call(r, 7);
    for (const b of data) { all.push(b); if (b !== 0xff) nonFF++; }
    // report any non-FF chunk immediately
    if (data.some((b) => b !== 0xff)) {
      console.log(`  @${offset}: NON-FF -> ${hex(r)}`);
    }
    iters++;
    if (status !== 0x01) { console.log(`ended @${offset}: status=0x${status.toString(16)} (${all.length} bytes read)`); break; }
    offset += 0x37;
  }
  console.log(`\nswept ${all.length} bytes in ${iters} reads; non-FF bytes: ${nonFF}`);
  if (nonFF === 0) {
    console.log("Entire swept region is 0xFF (erased) — no stored config on this band.");
  } else {
    require("fs").writeFileSync("fuelband-memsweep.bin", Buffer.from(all));
    console.log("Wrote fuelband-memsweep.bin — non-FF data present, worth analyzing.");
  }
}

// Read the band's memory via read-memory-int (0x19): request = [0x19, addr(3 BE)];
// reply (data-family) = [01, len, 0x19, flag, addr(3), ...data]. Dumps [start,start+length)
// and saves it, printing the first few raw replies so we can confirm the structure.
async function readMem(dev, start, length, outFile = "fuelband-mem.bin") {
  console.log(`\n=== READ MEMORY (0x19) 0x${start.toString(16)}..0x${(start + length).toString(16)} ===`);
  const out = [];
  let addr = start, iters = 0, printed = 0;
  const end = start + length;
  while (addr < end && iters < 4000) {
    const req = [0x19, (addr >> 16) & 0xff, (addr >> 8) & 0xff, addr & 0xff];
    outWrite(dev, frameData(req));
    await delay(45);
    const r = tryRead(dev, 4);
    if (!r || !r.data || r.data.length < 8) {
      console.log(`@0x${addr.toString(16)}: short/no reply (${r && r.data ? hex(r.data) : "none"})`);
      break;
    }
    const reply = r.data;               // [01, len, 19, flag, a2, a1, a0, ...data]
    if (printed < 4) { console.log(`@0x${addr.toString(16)}: ${hex(reply)}`); printed++; }
    if (reply[2] !== 0x19) { console.log(`@0x${addr.toString(16)}: not a 0x19 reply -> ${hex(reply)}`); break; }
    const data = Array.prototype.slice.call(reply, 7);
    if (!data.length) { console.log(`@0x${addr.toString(16)}: empty data, stopping`); break; }
    for (const b of data) out.push(b);
    addr += data.length;
    iters++;
  }
  if (out.length) {
    require("fs").writeFileSync(outFile, Buffer.from(out));
    const nonFF = out.filter((b) => b !== 0xff).length;
    console.log(`\nread ${out.length} bytes -> ${outFile}  (non-FF: ${nonFF})`);
  } else {
    console.log("No data read — 0x19 may need a length arg or a different request format.");
  }
}

// Fuzz the desktop-write framing. A command the band PROCESSES replies with
// length > 1 (like the working mem read: 01 3d bb ...); one it ignores replies
// 01 01 <opcode> (echo). We sweep structure variants with a short test payload
// and flag any that engage. Safe: only opcode 0x51 (the known desktop-write op).
async function fuzzWrite(dev) {
  console.log("\n=== FUZZ desktop-write framing (looking for engagement) ===");
  const test = [0xde, 0xad, 0xbe, 0xef]; // short probe payload
  const prefixes = {
    "none": [],
    "83a2": [0x83, 0xa2],
    "P76": [0x50, 0x37, 0x36],
    "83a2+P76": [0x83, 0xa2, 0x50, 0x37, 0x36],
  };
  const headers = {
    "none": [],
    "flag+off3": [0x00, 0x00, 0x00, 0x00],
    "off3": [0x00, 0x00, 0x00],
    "len": [4 + 9], // a length-ish byte
  };
  const frames = { "data": frameData, "07": frameSys };
  let engaged = [];
  for (const opcode of [0x51, 0x52]) {
    for (const [pn, pre] of Object.entries(prefixes)) {
      for (const [hn, hdr] of Object.entries(headers)) {
        for (const [fn, frame] of Object.entries(frames)) {
          const cmd = [opcode, ...hdr, ...pre, ...test];
          outWrite(dev, frame(cmd));
          await delay(40);
          const r4 = tryRead(dev, 4), r1 = tryRead(dev, 1);
          const rep = r4.data && r4.data.length ? r4.data : (r1.data || []);
          const len = rep[1] ?? 0;
          const eng = len > 1;
          const tag = `op${opcode.toString(16)} pre:${pn} hdr:${hn} ${fn}`;
          if (eng) { engaged.push(tag); console.log(`  ENGAGED  ${tag}  -> ${hex(rep)}`); }
        }
      }
    }
  }
  console.log(engaged.length
    ? `\n${engaged.length} variant(s) engaged — that's the write framing. Next: send the real blob that way.`
    : "\nNothing engaged. The desktop write likely replies over the unreadable channel, so we can't confirm it this way.");
}

// Read desktop region at an offset: 0x51 50 37 36 + off(3 BE); reply
// [01,len,51,status,off(3),...data]. Returns the data bytes.
async function readDesktop(dev, offset) {
  const o = [(offset >> 16) & 0xff, (offset >> 8) & 0xff, offset & 0xff];
  const cmd = [0x51, 0x50, 0x37, 0x36, ...o];
  // Prefer the 07-wrapped framing (the form the band actually answers on for
  // command opcodes); fall back to the plain data framing.
  outWrite(dev, frameSys(cmd));
  await delay(70);
  let r = tryRead(dev, 1);
  if (r.data && r.data.length > 3) return r.data;
  outWrite(dev, frameData(cmd));
  await delay(70);
  r = tryRead(dev, 4);
  return r.data || [];
}

// Write bytes to desktop region: 0x52 50 37 36 + off(3 BE) + data.
async function writeDesktop(dev, offset, data) {
  const o = [(offset >> 16) & 0xff, (offset >> 8) & 0xff, offset & 0xff];
  outWrite(dev, frameData([0x52, 0x50, 0x37, 0x36, ...o, ...data]));
  await delay(80);
  const r = tryRead(dev, 4);
  return r.data || [];
}

// Try several write structures (the app uses a 0x83 0xa2 write marker via the
// chunked transfer), reading back via 0x51 50 37 36 after each to see which sticks.
async function writeTest2(dev) {
  console.log("\n=== WRITE STRUCTURE SEARCH (read-back verified) ===");
  const b3 = (o) => [(o >> 16) & 0xff, (o >> 8) & 0xff, o & 0xff];
  const structs = [
    ["W1 op51 flag+off3 +83a2", (o, d) => [0x51, 0, ...b3(o), 0x83, 0xa2, ...d]],
    ["W2 op51 83a2 +off3",      (o, d) => [0x51, 0x83, 0xa2, ...b3(o), ...d]],
    ["W3 op51 P76 +off3 +83a2", (o, d) => [0x51, 0x50, 0x37, 0x36, ...b3(o), 0x83, 0xa2, ...d]],
    ["W4 op52 flag+off3 +83a2", (o, d) => [0x52, 0, ...b3(o), 0x83, 0xa2, ...d]],
    ["W5 op52 P76 +off3 +83a2", (o, d) => [0x52, 0x50, 0x37, 0x36, ...b3(o), 0x83, 0xa2, ...d]],
    ["W6 op51 83a2 P76 +off3",  (o, d) => [0x51, 0x83, 0xa2, 0x50, 0x37, 0x36, ...b3(o), ...d]],
  ];
  const test = [0xaa, 0xbb, 0xcc, 0xdd, 0x11, 0x22, 0x33, 0x44];
  const testHex = hex(test);
  for (const [name, mk] of structs) {
    const cmd = mk(0, test);
    outWrite(dev, frameData(cmd));
    await delay(90);
    const wr = tryRead(dev, 4);
    await delay(130);
    const back = await readDesktop(dev, 0);
    const data = Array.prototype.slice.call(back, 7, 7 + test.length);
    const stuck = hex(data) === testHex;
    console.log(`${name}\n    sent: ${hex(cmd)}\n    wrReply: ${hex(wr.data || [])}\n    readback@0: ${hex(data)}  ${stuck ? "*** STUCK ***" : ""}`);
  }
  console.log("\nAny '*** STUCK ***' line = that's the write structure. If none, the writes");
  console.log("may reply/commit via the unreadable channel or need save — next step from the bytes.");
}

// Write-structure search v3: the write offset IS the region address 0x503736,
// so put 50 37 36 into the chunk as the address, with a marker to force a write.
async function writeTest3(dev) {
  console.log("\n=== WRITE STRUCTURE SEARCH v3 (address = 50 37 36) ===");
  const d = [0xaa, 0xbb, 0xcc, 0xdd, 0x11, 0x22, 0x33, 0x44];
  const dh = hex(d);
  const structs = [
    ["A op51 P76+83a2",         [0x51, 0x50, 0x37, 0x36, 0x83, 0xa2, ...d]],
    ["B op51 f1+P76+83a2",      [0x51, 0x01, 0x50, 0x37, 0x36, 0x83, 0xa2, ...d]],
    ["C op51 P76+off0+83a2",    [0x51, 0x50, 0x37, 0x36, 0x00, 0x00, 0x00, 0x83, 0xa2, ...d]],
    ["D op52 P76+83a2",         [0x52, 0x50, 0x37, 0x36, 0x83, 0xa2, ...d]],
    ["E op51 83a2+P76",         [0x51, 0x83, 0xa2, 0x50, 0x37, 0x36, ...d]],
    ["F op51 P76+data",         [0x51, 0x50, 0x37, 0x36, ...d]],
    ["G op52 P76+off0+data",    [0x52, 0x50, 0x37, 0x36, 0x00, 0x00, 0x00, ...d]],
    ["H op51 f2+P76+83a2",      [0x51, 0x02, 0x50, 0x37, 0x36, 0x83, 0xa2, ...d]],
  ];
  for (const [name, cmd] of structs) {
    outWrite(dev, frameData(cmd));
    await delay(90);
    const wr = tryRead(dev, 4);
    await delay(130);
    const back = await readDesktop(dev, 0);
    const data = Array.prototype.slice.call(back, 7, 7 + d.length);
    const stuck = data.some((b, i) => b === d[i] && b !== 0xff);
    console.log(`${name}: wr ${hex(wr.data || []).slice(0, 17)} | back ${hex(data)} ${stuck ? "*** CHANGED ***" : ""}`);
  }
}

// Fuzz opcodes to find one that WRITES the desktop region. For each candidate
// opcode we send [op, 50 37 36, off0, testdata] and read back to see if the
// region changed. Restricted to the memory/desktop opcode ranges (0x50-0x5f,
// 0xb0-0xbf) to avoid reset/erase/latchup/boot commands.
async function fuzzWriteOpcodes(dev) {
  console.log("\n=== FUZZ WRITE OPCODES (region 50 37 36, read-back verified) ===");
  const test = [0xa5, 0x5a, 0xc3, 0x3c, 0x77, 0x88];
  const th = hex(test);
  const opcodes = [];
  for (let o = 0x50; o <= 0x5f; o++) opcodes.push(o);
  for (let o = 0xb0; o <= 0xbf; o++) opcodes.push(o);
  let changed = [];
  for (const op of opcodes) {
    // two arrangements: with an explicit 3-byte offset, and without
    for (const withOff of [true, false]) {
      const cmd = withOff
        ? [op, 0x50, 0x37, 0x36, 0x00, 0x00, 0x00, ...test]
        : [op, 0x50, 0x37, 0x36, ...test];
      outWrite(dev, frameData(cmd));
      await delay(70);
      tryRead(dev, 4);
      await delay(110);
      const back = await readDesktop(dev, 0);
      const data = Array.prototype.slice.call(back, 7, 7 + test.length);
      if (data.some((b, i) => b === test[i] && b !== 0xff)) {
        const tag = `op 0x${op.toString(16)} ${withOff ? "+off" : ""}`;
        changed.push(tag);
        console.log(`  *** REGION CHANGED by ${tag} -> readback ${hex(data)}`);
      }
    }
  }
  console.log(changed.length
    ? `\nFound write opcode(s): ${changed.join(", ")} — that's the write primitive!`
    : "\nNo opcode in 0x50-0x5f/0xb0-0xbf wrote the region. The write needs the stateful transfer, not a single opcode.");
}

// Critical test: can we write to the desktop region and read it back?
async function writeTest(dev) {
  console.log("\n=== WRITE TEST (0x52 50 37 36) with read-back ===");
  console.log(`before @0: ${hex(await readDesktop(dev, 0))}`);
  const test = [0xaa, 0xbb, 0xcc, 0xdd, 0x11, 0x22, 0x33, 0x44];
  const wr = await writeDesktop(dev, 0, test);
  console.log(`write reply: ${hex(wr)}`);
  await delay(150);
  const after = await readDesktop(dev, 0);
  console.log(`after  @0: ${hex(after)}`);
  const dataAfter = Array.prototype.slice.call(after, 7, 7 + test.length);
  const stuck = hex(dataAfter) === hex(test);
  console.log(stuck
    ? "\n*** WRITE VERIFIED — the test pattern read back. We can write the desktop region. ***"
    : "\nTest pattern did not read back; the write needs a different structure (offset/prefix). Raw bytes above will tell us what to adjust.");
}

// Chunked desktop write in the app's structure: each chunk is
// [0x51, moreFlag, off(3 BE), 0x83, 0xa2, ...data], offset = cumulative data
// bytes sent (moreFlag = 1 once offset > 0).
async function chunkedWriteDesktop(dev, blob) {
  const xfer = new FuelBandTransfer(dev, { verbose: false });
  const replies = await xfer.send(blob);
  return replies.map((r) => (r.length ? hex(r).slice(0, 14) : "-"));
}

// Full imprint via chunked write + read-back verification.
async function imprint2(dev) {
  console.log("\n=== IMPRINT v2 (chunked write, read-back + status verified) ===");
  const base = await imprintedBit(dev);
  const dumpFront = async () => {
    const parts = [];
    for (let off = 0; off < 120; off += 0x37) {
      const r = await readDesktop(dev, off);
      parts.push(...Array.prototype.slice.call(r, 7));
    }
    return parts;
  };
  console.log(`baseline imprinted=${base.bit}; region head: ${hex((await dumpFront()).slice(0, 24))}`);

  for (const val of [0x00000001, 0x000000ff, 0xffffffff]) {
    const blob = buildConfigBlob(val, { clockAutoSet: 1 });
    console.log(`\n-- imprint_state=0x${val.toString(16).padStart(8, "0")} blob=${blob.length}B, writing ${Math.ceil(blob.length / 48)} chunks --`);
    const replies = await chunkedWriteDesktop(dev, blob);
    console.log(`  chunk replies: ${replies.join(" | ")}`);
    await delay(200);
    const head = (await dumpFront());
    console.log(`  region head after: ${hex(head.slice(0, 24))}`);
    const committed = head.slice(0, blob.length).some((b, i) => b === blob[i] && b !== 0xff);
    const after = await imprintedBit(dev);
    console.log(`  imprinted=${after.bit}  ${committed ? "(region CHANGED — write committed!)" : "(region still FF — not committed)"}`);
    if (after.bit === 1) { console.log(`\n  *** IMPRINTED with 0x${val.toString(16)} ***`); return; }
    if (committed) { console.log("  write landed but didn't imprint — likely need save or a different imprint_state. Big progress."); return; }
  }
  console.log("\nNothing committed. The blob format/CRC is likely being rejected — read-back is our oracle to fix it.");
}

// ---------------------------------------------------------------------------
// FuelBandTransfer — byte-for-byte reimplementation of the app's chunked
// transfer routine at FuelBandPlugin.dll:0x100386f0.
//
// Device-side state the DLL maintains (offsets into its device object):
//   this+0x180  the full payload buffer
//   this+0x18c  bytes already sent  (the transfer offset — NOT the region)
//   this+0x190  "transfer complete" flag, set when the last chunk goes out
//
// Chunk layout, in the exact append order of the disassembly:
//   [extra…][flag][off>>16][off>>8][off&0xff][data…]
// where extra = 0x83 0xa2 for desktop data (doSetDesktopData @0x1003AE10),
// and the whole chunk is sent as the body of opcode 0x51.
//
//   flag = 0  first chunk (offset == 0)
//        = 1  continuation
//        = 2  final chunk — but only rewritten to 2 if it was already non-zero,
//             so a single-chunk transfer keeps flag 0.
//
// Data budget per chunk: 0x3c - chunkHeaderLen - 1 = 60 - 6 - 1 = 53 bytes.
//
// NOTE: earlier attempts sent [83 a2][3 offset bytes] — one byte short. The
// header carries a flag byte AND a 3-byte offset (4 bytes after the marker).
// ---------------------------------------------------------------------------
class FuelBandTransfer {
  constructor(dev, { opcode = 0x51, extra = [0x83, 0xa2], verbose = true, framing = "sys" } = {}) {
    this.dev = dev;
    this.opcode = opcode;
    this.extra = extra;
    this.verbose = verbose;
    this.framing = framing;   // "sys" = 07-wrapped (the form the band answers on)
    this.offset = 0;
    this.done = false;
    this.replies = [];
  }

  buildChunk(buffer) {
    const chunk = [...this.extra];
    const flagIndex = chunk.length;
    chunk.push(this.offset !== 0 ? 1 : 0);
    chunk.push((this.offset >> 16) & 0xff, (this.offset >> 8) & 0xff, this.offset & 0xff);

    const space = 0x3c - chunk.length - 1;         // 53
    const remaining = buffer.length - this.offset;
    let take = space;
    if (remaining <= space) {
      take = remaining;
      if (chunk[flagIndex] !== 0) chunk[flagIndex] = 2;  // final-chunk marker
      this.done = true;
    }
    chunk.push(...buffer.slice(this.offset, this.offset + take));
    this.offset += take;
    return chunk;
  }

  async send(buffer) {
    this.offset = 0;
    this.done = false;
    this.replies = [];
    while (this.offset < buffer.length) {
      const chunk = this.buildChunk(buffer);
      const cmd = [this.opcode, ...chunk];
      const useSys = this.framing === "sys";
      outWrite(this.dev, useSys ? frameSys(cmd) : frameData(cmd));
      await delay(80);
      const r = tryRead(this.dev, useSys ? 1 : 4);
      const reply = r.data || [];
      this.replies.push(reply);
      if (this.verbose) {
        console.log(`  chunk @${this.offset - (chunk.length - 6)} flag=${chunk[this.extra.length]} ` +
                    `(${chunk.length - 6}B data)`);
        console.log(`    sent:  ${hex(cmd).slice(0, 80)}${cmd.length > 27 ? " …" : ""}`);
        console.log(`    reply: ${r.error ? "ERR " + r.error : hex(reply).slice(0, 60)}`);
      }
    }
    return this.replies;
  }
}

// Send an arbitrary payload through the corrected transfer, then read back.
async function xferTest(dev, payload) {
  console.log("\n=== TRANSFER TEST (corrected chunk header) ===");
  console.log(`payload: ${hex(payload)} (${payload.length}B)`);
  const before = await readDesktop(dev, 0);
  console.log(`before @0: ${hex(Array.prototype.slice.call(before, 7, 7 + 16))}`);

  const xfer = new FuelBandTransfer(dev);
  await xfer.send(payload);

  await delay(200);
  const after = await readDesktop(dev, 0);
  const data = Array.prototype.slice.call(after, 7, 7 + payload.length);
  console.log(`after  @0: ${hex(Array.prototype.slice.call(after, 7, 7 + 16))}`);

  const exact = hex(data) === hex(payload);
  const partial = data.some((b, i) => b === payload[i] && b !== 0xff);
  if (exact) console.log("\n*** WRITE COMMITTED — payload read back exactly. ***");
  else if (partial) console.log("\n*** REGION CHANGED (partial match) — write is landing. ***");
  else console.log("\nRegion unchanged. Reply bytes above show how the band parsed it.");
  return exact || partial;
}

// Diagnostic ladder: three transfers that isolate different failure modes,
// each verified by reading the desktop region back.
//
//   A  4 bytes   single chunk, flag 0 only — the path the real app never used
//                (its blob is ~161B), so a failure here is weakly informative
//   B  54 bytes  two chunks, flags 0 then 2 — exercises the final-marker
//                rewrite at 0x10038912, but is not a valid DesktopOptions blob
//   C  valid blob, correct length + CRC-16 — the only payload the firmware
//                should accept if it validates before committing
//
// If C commits but B doesn't, the firmware validates before commit.
// If B commits but C doesn't, the blob layout is wrong (transfer is fine).
// If none commit, the inner packet is still wrong — but NOT the outer framing,
// which readDesktop() already proves works over the same output-report path.
async function ladder(dev) {
  console.log("\n=== TRANSFER LADDER ===");
  const readHead = async (n) => {
    const r = await readDesktop(dev, 0);
    return Array.prototype.slice.call(r, 7, 7 + n);
  };

  const tests = [
    { name: "A single-chunk raw (4B, flag 0)", payload: [0xaa, 0xbb, 0xcc, 0xdd] },
    { name: "B multi-chunk raw (54B, flags 0,2)", payload: Array.from({ length: 54 }, (_, i) => i) },
    { name: "C valid blob (CRC-16, multi-chunk)", payload: buildConfigBlob(0x00000001, { clockAutoSet: 1 }) },
  ];

  const results = [];
  for (const t of tests) {
    console.log(`\n--- ${t.name} — ${t.payload.length}B ---`);
    const before = await readHead(Math.min(t.payload.length, 16));
    const xfer = new FuelBandTransfer(dev, { verbose: true });
    await xfer.send(t.payload);
    await delay(250);
    const after = await readHead(Math.min(t.payload.length, 16));
    const changed = after.some((b) => b !== 0xff);
    const matches = after.filter((b, i) => b === t.payload[i]).length;
    console.log(`  before: ${hex(before)}`);
    console.log(`  after : ${hex(after)}`);
    console.log(`  -> ${changed ? `REGION CHANGED (${matches}/${after.length} bytes match payload)` : "unchanged (all 0xff)"}`);
    results.push({ name: t.name, changed, matches, of: after.length });
  }

  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    console.log(`  ${r.changed ? "CHANGED" : "  --   "}  ${r.name}${r.changed ? `  (${r.matches}/${r.of} match)` : ""}`);
  }
  const anyChanged = results.some((r) => r.changed);
  if (!anyChanged) {
    console.log("\nNothing committed. Outer framing is NOT the suspect — readDesktop() uses the");
    console.log("same output-report path and returns valid 0x3d replies. Next: the inner packet.");
  } else {
    console.log("\nWrite path is live. Next: confirm persistence (re-read after replug), then save-to-flash.");
  }
  const st = await imprintedBit(dev);
  console.log(`imprinted bit: ${st.bit}`);
}

// Query whatever state a bare 0x51 reports. The fuzz showed this returns
// 01 07 51 00 00 00 00 00 00 — six bytes that look like [status][offset:3][..].
// If those bytes move after a transfer, the payload is being STAGED even though
// the flash region still reads 0xff, which would mean we only need the commit.
async function transferState(dev, label) {
  const forms = [
    ["bare 51", [0x51]],
    ["51+len", [0x51, 0x09]],
  ];
  const out = [];
  for (const [n, cmd] of forms) {
    outWrite(dev, frameData(cmd));
    await delay(60);
    const r = tryRead(dev, 4);
    out.push(`${n}: ${r.error ? "ERR" : hex(r.data)}`);
  }
  console.log(`  state ${label}: ${out.join("  |  ")}`);
  return out.join("|");
}

// Candidate commit/save opcodes. Deliberately NOT a blind sweep: these are
// entries that appear in the DLL's command table but have no identifying
// completion string, which is what a no-response command like "save all
// programmable parameters to flash" looks like. Known-destructive commands
// (reset, restoreDefaults, eeprom-erase, latchup, bootblock, network-flash,
// firmware-image) are excluded by construction.
const COMMIT_CANDIDATES = [
  [[0x28], "0x28  table entry, no completion string — best save candidate"],
  [[0x50], "0x50  adjacent to the desktop-data pair"],
  [[0x53], "0x53  adjacent to the desktop-data pair"],
  [[0x54], "0x54  adjacent to the desktop-data pair"],
];

// Issue a region selector in the READ form (no data bytes) to ask whether the
// firmware knows that region at all. 0x503736 is the control: it must answer
// 01 3d ... If 0x83a2xx answers 01 01 51, this firmware has no such region.
async function regionProbe(dev) {
  console.log("\n=== REGION EXISTENCE PROBE (read form, no data) ===");
  const regions = [
    [[0x50, 0x37, 0x36], "0x503736  desktop read  (CONTROL — must answer)"],
    [[0x83, 0xa2, 0x00], "0x83a200  write, first chunk selector"],
    [[0x83, 0xa2, 0x01], "0x83a201  write, continuation selector"],
    [[0x83, 0xa2, 0x02], "0x83a202  write, final selector"],
  ];
  for (const [r, note] of regions) {
    outWrite(dev, frameData([0x51, ...r, 0x00, 0x00, 0x00]));
    await delay(80);
    const rep = tryRead(dev, 4);
    const d = rep.data || [];
    const known = d.length > 3;
    console.log(`  ${note}\n      -> ${rep.error ? "ERR " + rep.error : hex(d).slice(0, 44)}   ${known ? "REGION EXISTS" : "not recognised"}`);
  }
}

// Does a transfer stage, and can we commit it?
async function commitTest(dev) {
  console.log("\n=== STAGE / COMMIT TEST ===");
  await regionProbe(dev);

  const payloads = [
    ["A 4B  single chunk", [0xaa, 0xbb, 0xcc, 0xdd]],
    ["B 54B two chunks  ", Array.from({ length: 54 }, (_, i) => i)],
    ["C valid blob      ", buildConfigBlob(0x00000001, { clockAutoSet: 1 })],
  ];

  console.log("\n=== TRANSFER STATE PER PAYLOAD ===");
  const baseline = await transferState(dev, "baseline");
  const seen = [["baseline", baseline]];
  for (const [name, payload] of payloads) {
    const xfer = new FuelBandTransfer(dev, { verbose: false });
    await xfer.send(payload);
    await delay(150);
    const st = await transferState(dev, name);
    seen.push([name, st]);
  }
  const moved = seen.slice(1).filter(([, s]) => s !== baseline).map(([n]) => n.trim());
  console.log(moved.length
    ? `\n  *** STATE MOVED after: ${moved.join(", ")} — something is being staged. ***`
    : "\n  state identical after every payload — nothing is being staged.");

  console.log("\n=== COMMIT CANDIDATES (read-back after each) ===");
  const head = async () => {
    const r = await readDesktop(dev, 0);
    return hex(Array.prototype.slice.call(r, 7, 7 + 16));
  };
  const regionBase = await head();
  console.log(`  region before commits: ${regionBase}`);
  for (const [cmd, note] of COMMIT_CANDIDATES) {
    outWrite(dev, frameData(cmd));
    await delay(120);
    const r = tryRead(dev, 4);
    await delay(200);
    const now = await head();
    const changed = now !== regionBase;
    console.log(`  ${note}\n      reply: ${r.error ? "ERR" : hex(r.data)}   region: ${now}${changed ? "   *** CHANGED ***" : ""}`);
    if (changed) { console.log("\n  *** COMMIT FOUND — that opcode flushed the staged data. ***"); return; }
  }

  console.log("\nNo candidate committed. Read the two sections above together:");
  console.log("  region exists + state moved -> transfer lands, only the flush is missing");
  console.log("  region NOT recognised       -> this firmware has no 0x83a2xx; static analysis ends here");
}

// Opcodes the DLL's command table knows about, for cross-referencing.
const KNOWN_OPCODES = {
  0x07: "chunked transfer: NP image", 0x08: "version", 0x09: "chunked transfer: main FW image",
  0x0a: "network version", 0x0b: "network flash", 0x13: "battery", 0x17: "sample query",
  0x18: "?", 0x19: "read memory int", 0x1a: "goal", 0x1c: "?", 0x1f: "model?",
  0x21: "assessment metrics", 0x24: "battery?", 0x25: "fuel", 0x28: "?",
  0x31: "time", 0x32: "24-hour", 0x33: "metric", 0x34: "weight", 0x35: "height",
  0x36: "age", 0x37: "display loop", 0x38: "orientation", 0x39: "goal options",
  0x3a: "gender", 0x3b: "display format", 0x40: "timestamp", 0x41: "?", 0x42: "?",
  0x50: "?", 0x51: "get desktop data", 0x52: "set desktop data", 0x60: "protocol version",
  0xbb: "memory read", 0xce: "progress", 0xdf: "status", 0xe0: "model",
  0xe1: "serial", 0xe2: "hw revision", 0xf2: "firmware image",
};

// Map the firmware's actual command surface. Per the DLL's own convention
// (handler at 0x10037C20) an EMPTY response body means "operation not
// recognized by firmware", so a bare opcode tells us whether F2.12 implements
// it at all. Comparing the recognised set against the DLL's table discriminates:
//
//   opcodes recognised that the DLL never uses  -> F2.12 has its own commands (A)
//   recognised set == the DLL's read commands   -> no host write path here (B)
//
// SAFETY: 0x0b (network flash), 0xf2 (firmware image) and the chunked-transfer
// opcodes 0x07/0x09 are skipped. Others are sent bare, with no arguments.
// On a factory-blank band the destructive commands have nothing to destroy
// (reset/restoreDefaults = already factory, eeprom-erase = empty store) and
// latchup/bootblock recover by replugging or the ~10s button reset.
// 0x14 hung a real device (IOHIDDeviceSetReport I/O timeout) and required a
// replug, so it is skipped alongside the transfer/flash opcodes.
// Skipped: chunked transfers (0x07/0x09), network flash (0x0b), firmware image
// (0xf2), the opcode that latched a band off (0x14), and restoreDefaults (0x1c,
// which would wipe the settings we have written).
const SURFACE_SKIP = new Set([0x07, 0x09, 0x0b, 0x14, 0x1c, 0xf2]);

async function surfaceMap(dev, start = 0x00, end = 0xff) {
  console.log(`\n=== COMMAND SURFACE MAP (0x${start.toString(16)}–0x${end.toString(16)}) ===`);
  console.log("07-wrapped. Health-checked after every opcode; results written incrementally.\n");
  const fs = require("fs");
  const LOG = "surface-map.txt";
  fs.appendFileSync(LOG, `\n--- sweep 0x${start.toString(16)}-0x${end.toString(16)} @ ${new Date().toISOString()} ---\n`);
  // Confirm the band answers a known-good command; used to detect a wedge the
  // moment it happens rather than on the next write.
  const healthy = async () => {
    try {
      outWrite(dev, frameSys([0x08]));
      await delay(60);
      const d = tryRead(dev, 1).data || [];
      return d.length > 3;
    } catch { return false; }
  };
  if (!(await healthy())) {
    console.log("Band is not answering the version command — aborting before we start.");
    return;
  }
  const recognised = [];
  for (let op = start; op <= end; op++) {
    if (SURFACE_SKIP.has(op)) { console.log(`  0x${op.toString(16).padStart(2,"0")}  [skipped — unsafe]`); continue; }
    // 07-wrapped framing — the form the band actually answers on. The first
    // version of this sweep used the data framing and would have found nothing.
    // Writes are guarded: an opcode can wedge the device (0x14 did), and we want
    // the map so far rather than a stack trace.
    let d = [];
    try {
      outWrite(dev, frameSys([op]));
      await delay(45);
      d = tryRead(dev, 1).data || [];
    } catch (e) {
      console.log(`  0x${op.toString(16).padStart(2,"0")}  *** DEVICE STOPPED RESPONDING — ${e.message.split(":").pop().trim()}`);
      console.log(`\n  Sweep aborted at 0x${op.toString(16)}. Unplug/replug the band (hold the button ~10s if needed).`);
      console.log(`  Resume past it with:  --surface ${(op+1).toString(16)} ff`);
      break;
    }
    const body = d.length > 3 ? Array.prototype.slice.call(d, 3) : [];
    if (body.length) {
      const note = KNOWN_OPCODES[op] ? `DLL: ${KNOWN_OPCODES[op]}` : "*** NOT IN DLL TABLE ***";
      recognised.push([op, body, note]);
      const line = `  0x${op.toString(16).padStart(2,"0")}  RECOGNISED  ${hex(body).slice(0,36)}   ${note}`;
      console.log(line);
      fs.appendFileSync(LOG, line + "\n");
    }
    // Did this opcode wedge the band? Catch it now, while we know the culprit.
    if (!(await healthy())) {
      const msg = `  *** 0x${op.toString(16)} STOPPED THE BAND RESPONDING ***`;
      console.log(msg);
      fs.appendFileSync(LOG, msg + "\n");
      console.log(`  Unplug, charge on a wall adapter, then resume with:  --surface ${(op+1).toString(16)} ${end.toString(16)}`);
      console.log(`  Results so far are saved in tools/${LOG}`);
      return;
    }
  }
  console.log(`\n=== ${recognised.length} opcode(s) recognised ===`);
  const novel = recognised.filter(([op]) => !KNOWN_OPCODES[op]);
  if (novel.length) {
    console.log(`${novel.length} recognised but NOT in the DLL's table — candidates for an F2.12-specific path:`);
    for (const [op, body] of novel) console.log(`  0x${op.toString(16).padStart(2,"0")}  ${hex(body).slice(0,36)}`);
    console.log("\n-> supports hypothesis A: this firmware exposes commands the Windows DLL never used.");
  } else {
    console.log("Every recognised opcode is already in the DLL's table — no F2.12-specific commands found.");
    console.log("-> supports hypothesis B: no separate host write path on this firmware.");
  }
}

// ---------------------------------------------------------------------------
// AUTHORITATIVE submit opcodes.
//
// Recovered from every "Submitting %02X" log site in FuelBandPlugin.dll by
// exact byte pattern (`6a NN` push imm8 immediately preceding `68 <str>`), and
// cross-checked against full disassembly of the individual handlers.
//
// This SUPERSEDES the earlier table derived from the command-registration
// function, which was misaligned. In particular doTime submits 0x21 — the
// earlier table said 0x31, which is actually 24-hour mode. Every previous
// --set-clock run therefore sent a malformed 24-hour command.
// ---------------------------------------------------------------------------
const OP = {
  time: 0x21,        // [time:4 BE][gmtOffset:4 BE][dstMinutes:1]   (doTime)
  goal: 0x25,        // [type:1][goal:3 BE]                          (doGoal)
  is24Hour: 0x31,    // [bool:1]                                     (do24Hour)
};

// Send a command through BOTH framings and report which one the band engages
// with. Identity/status commands answer on the 07-tagged framing (feat#1);
// region-selected reads answer on the data framing (feat#4). The option
// commands were only ever tried on the data framing — hence this.
async function sendBoth(dev, cmd, label) {
  const out = {};
  // data framing -> feat#4
  outWrite(dev, frameData(cmd));
  await delay(120);
  const d = tryRead(dev, 4).data || [];
  out.data = d;
  await delay(60);
  // 07-tagged system framing -> feat#1
  outWrite(dev, frameSys(cmd));
  await delay(120);
  const s = tryRead(dev, 1).data || [];
  out.sys = s;
  const live = (b) => b.length > 2 ? b.length - 2 : 0;   // payload bytes past [id,len]
  console.log(`  ${label.padEnd(22)} data[${hex(d) || "-"}]${live(d) > 1 ? " <ENGAGED>" : ""}`);
  console.log(`  ${"".padEnd(22)} sys [${hex(s) || "-"}]${live(s) > 1 ? " <ENGAGED>" : ""}`);
  return out;
}

// Set the clock with the CORRECT opcode.
async function setClock2(dev) {
  const now = Math.floor(Date.now() / 1000);
  const offMin = -new Date().getTimezoneOffset();
  const gmt = (offMin * 60) >>> 0;
  const cmd = [OP.time, ...beU32(now), ...beU32(gmt), 0x00];
  console.log(`\n=== SET CLOCK (opcode 0x${OP.time.toString(16)} — corrected) ===`);
  console.log(`local: ${new Date(now * 1000).toString()}`);
  console.log(`sent : ${hex(cmd)}`);
  outWrite(dev, frameData(cmd));
  await delay(150);
  const r4 = tryRead(dev, 4), r1 = tryRead(dev, 1);
  console.log(`reply feat#4: ${r4.error ? "ERR" : hex(r4.data)}`);
  console.log(`reply feat#1: ${r1.error ? "ERR" : hex(r1.data)}`);
  await delay(150);
  outWrite(dev, frameData([OP.time]));            // read it back
  await delay(120);
  const rb = tryRead(dev, 4);
  console.log(`read back   : ${rb.error ? "ERR" : hex(rb.data)}`);
  if (rb.data && rb.data.length > 3) {
    const d = rb.data;
    for (let off = 3; off + 4 <= d.length; off++) {
      const t = ((d[off] << 24) | (d[off+1] << 16) | (d[off+2] << 8) | d[off+3]) >>> 0;
      if (t > 1500000000 && t < 2000000000) console.log(`  -> decoded time @${off}: ${new Date(t*1000).toString()}`);
    }
  }
}

// Set the daily fuel goal (doGoal: [type][goal:3 BE]).
async function setGoal(dev, goal = 2000, type = 0) {
  const cmd = [OP.goal, type, (goal >> 16) & 0xff, (goal >> 8) & 0xff, goal & 0xff];
  console.log(`\n=== SET GOAL ${goal} (opcode 0x${OP.goal.toString(16)}, type ${type}) ===`);
  console.log(`sent : ${hex(cmd)}`);
  outWrite(dev, frameData([OP.goal, type]));       // read current first
  await delay(120);
  const before = tryRead(dev, 4);
  console.log(`before: ${before.error ? "ERR" : hex(before.data)}`);
  outWrite(dev, frameData(cmd));
  await delay(150);
  const wr = tryRead(dev, 4);
  console.log(`write reply: ${wr.error ? "ERR" : hex(wr.data)}`);
  await delay(150);
  outWrite(dev, frameData([OP.goal, type]));
  await delay(120);
  const after = tryRead(dev, 4);
  console.log(`after : ${after.error ? "ERR" : hex(after.data)}`);
  const changed = hex(before.data || []) !== hex(after.data || []);
  console.log(changed ? "  *** GOAL CHANGED — individual option writes WORK ***" : "  unchanged");
  return changed;
}

// Try activating the band the way the pre-blob protocol would have:
// individual option writes rather than a config blob.
async function activate(dev) {
  console.log("\n=== ACTIVATE via individual option commands (both framings) ===");
  const st0 = await imprintedBit(dev);
  console.log(`imprinted before: ${st0.bit}   status ${st0.raw ? hex(st0.raw) : "-"}`);

  const now = Math.floor(Date.now() / 1000);
  const gmt = ((-new Date().getTimezoneOffset()) * 60) >>> 0;

  const steps = [
    ["time READ",     [OP.time]],
    ["time WRITE",    [OP.time, ...beU32(now), ...beU32(gmt), 0x00]],
    ["time READ",     [OP.time]],
    ["goal READ",     [OP.goal, 0x00]],
    ["goal WRITE 2000",[OP.goal, 0x00, 0x00, 0x07, 0xd0]],
    ["goal READ",     [OP.goal, 0x00]],
    ["24hour READ",   [OP.is24Hour]],
    ["24hour WRITE 1",[OP.is24Hour, 0x01]],
    ["24hour READ",   [OP.is24Hour]],
  ];
  for (const [label, cmd] of steps) {
    console.log(`\n${label}  sent: ${hex(cmd)}`);
    await sendBoth(dev, cmd, label);
  }

  const st1 = await imprintedBit(dev);
  console.log(`\nimprinted after: ${st1.bit}   status ${st1.raw ? hex(st1.raw) : "-"}`);
  console.log("\nLook for <ENGAGED> above, and for a READ value that CHANGED after its WRITE.");
  console.log("Then UNPLUG the band and press its button — does it show a clock?");
}

// Read-only state probe through the 07 wrapper — the framing the band answers
// on. Reads the commands that only became reachable once the wrapper was found.
async function probe2(dev) {
  console.log("\n=== STATE PROBE (07-wrapped reads) ===");
  const READS = [
    [[0xdf], "status"],
    [[0x21], "time"],
    [[0x25, 0x00], "goal (type 0)"],
    [[0x31], "24-hour"],
    [[0x28], "run-state        (doRunState)"],
    [[0x1f], "sync-finished    (doSyncFinished)"],
    [[0x17], "sample-query"],
    [[0x1a], "?0x1a"],
    [[0x24], "?0x24"],
    [[0x60], "protocol version"],
    [[0x08], "version"],
  ];
  for (const [cmd, label] of READS) {
    outWrite(dev, frameSys(cmd));
    await delay(90);
    const r = tryRead(dev, 1);
    const d = r.data || [];
    const live = d.length > 3;
    console.log(`  ${label.padEnd(34)} ${hex(cmd).padEnd(8)} -> ${hex(d) || "-"}${live ? "  <DATA>" : ""}`);
  }
  console.log("\nAll reads. Nothing written.");
}

// doRunState (0x28) — payload derived exactly from the DLL (fn 0x1003CFC0):
//
//   f1 29 <state>
//   if (state & 1)  append (0x15180 - startInitiationOffset) as 4 bytes BIG-ENDIAN
//                   startInitiationOffset defaults to 0, and is clamped to
//                   0x1517f, so the default value is 0x00015180 (86400 = 1 day)
//
// The offset bytes are appended ONLY when bit 0 of state is set. There are
// therefore exactly two well-formed commands; earlier guesses used a 3-byte
// offset and a state value of 2, neither of which the DLL can produce.
async function runState(dev, state = 1) {
  console.log("\n=== RUN-STATE (0x28) ===");
  const snap = async (tag) => {
    outWrite(dev, frameSys([0xdf]));
    await delay(90);
    const st = tryRead(dev, 1).data || [];
    outWrite(dev, frameSys([0x21]));
    await delay(90);
    const tm = tryRead(dev, 1).data || [];
    console.log(`  ${tag}: status ${hex(st)}   time ${hex(tm)}`);
    return hex(st);
  };
  const cmd = (state & 1)
    ? [0x28, 0xf1, 0x29, state, 0x00, 0x01, 0x51, 0x80]
    : [0x28, 0xf1, 0x29, state];
  const before = await snap("before");
  console.log(`\n  sending state ${state}: ${hex(cmd)}`);
  try {
    outWrite(dev, frameSys(cmd));
    await delay(160);
    const r = tryRead(dev, 1).data || [];
    console.log(`  reply: ${hex(r) || "-"}${r.length > 3 ? "  <DATA>" : ""}`);
  } catch (e) {
    console.log(`  WRITE FAILED: ${e.message.split(":").pop().trim()}`);
    console.log("  Unplug/replug the band before doing anything else.");
    return;
  }
  const after = await snap("after ");
  console.log(after !== before ? "\n  *** STATUS CHANGED ***" : "\n  status unchanged");
  console.log("  Revert with:  --runstate 0");
}

// ---------------------------------------------------------------------------
// ACTIVATION FUZZ — payload variation only, on commands we can name.
//
// Deliberately NOT an opcode sweep. Everything here goes through 0x51 (the
// verified config transfer) or 0x42 (timestamps). No unknown opcodes are ever
// sent; that is what disabled a band earlier.
// ---------------------------------------------------------------------------

// Build a config blob with controllable identifier fields and TLVs.
function buildBlob({ imprintState = 1, din = null, udi = null, groupId = null, extraTLVs = [] } = {}) {
  const field48 = (v) => {
    const out = new Array(48).fill(0);
    if (v) for (let i = 0; i < Math.min(v.length, 48); i++) out[i] = v.charCodeAt(i);
    return out;
  };
  const payload = [...field48(din), ...field48(udi), ...field48(groupId)];
  payload.push(0x00, 0x0b, 0x04, (imprintState >>> 24) & 0xff, (imprintState >>> 16) & 0xff,
               (imprintState >>> 8) & 0xff, imprintState & 0xff);
  for (const t of extraTLVs) payload.push(...t);
  const total = payload.length + 6;
  const crc = crc16xmodem(payload);
  return [(total >>> 24) & 0xff, (total >>> 16) & 0xff, (total >>> 8) & 0xff, total & 0xff,
          ...payload, (crc >> 8) & 0xff, crc & 0xff];
}

async function statusBytes(dev) {
  outWrite(dev, frameSys([0xdf]));
  await delay(90);
  const d = tryRead(dev, 1).data || [];
  return d.length > 3 ? Array.prototype.slice.call(d, 3) : [];
}

async function fuzzActivation(dev) {
  console.log("\n=== ACTIVATION FUZZ (named commands, payload variation only) ===");
  const base = await statusBytes(dev);
  console.log(`baseline status: ${hex(base)}   imprinted=${base.length ? base[0] & 1 : "?"}\n`);
  let hits = 0;

  const check = async (label) => {
    const st = await statusBytes(dev);
    const changed = hex(st) !== hex(base);
    const imp = st.length ? st[0] & 1 : 0;
    console.log(`    status ${hex(st)}  imprinted=${imp}${changed ? "   *** CHANGED ***" : ""}`);
    if (imp === 1) { console.log(`\n*** IMPRINTED — ${label} ***`); hits++; return true; }
    return false;
  };

  // Phase 1 — sweep imprint_state through the verified blob transfer.
  console.log("--- phase 1: imprint_state values ---");
  const values = [0x00000001, 0x00000002, 0x00000003, 0x0000000f, 0x000000ff,
                  0x0000ffff, 0xffffffff, 0x00000010, 0x00000100, 0x80000000,
                  0x7fffffff, 0x00010001];
  for (const v of values) {
    const blob = buildBlob({ imprintState: v });
    const x = new FuelBandTransfer(dev, { verbose: false });
    try { await x.send(blob); } catch (e) { console.log(`  0x${v.toString(16)}: write failed — ${e.message.split(":").pop().trim()}`); continue; }
    await delay(180);
    console.log(`  imprint_state=0x${v.toString(16).padStart(8, "0")}`);
    if (await check(`imprint_state=0x${v.toString(16)}`)) return;
  }

  // Phase 2 — plausible identifiers rather than empty ones.
  console.log("\n--- phase 2: populated DIN / UDI / group id ---");
  const uuid = "12345678-1234-1234-1234-123456789abc";
  const cases = [
    [{ din: uuid, imprintState: 1 }, "DIN only"],
    [{ din: uuid, udi: uuid, groupId: uuid, imprintState: 1 }, "all three"],
    [{ din: uuid, udi: uuid, groupId: "1", imprintState: 0xffffffff }, "all three + max state"],
  ];
  for (const [opts, label] of cases) {
    const x = new FuelBandTransfer(dev, { verbose: false });
    try { await x.send(buildBlob(opts)); } catch (e) { console.log(`  ${label}: write failed`); continue; }
    await delay(180);
    console.log(`  ${label}`);
    if (await check(label)) return;
  }

  // Phase 3 — timestamps. IDs 1..4 = device-init, assessment-start,
  // fuel-reset, goal-reset. Read form is 0x42 <id>; write adds a 4-byte BE time.
  console.log("\n--- phase 3: timestamps (0x42) ---");
  const now = Math.floor(Date.now() / 1000);
  for (const id of [0x01, 0x02, 0x03, 0x04]) {
    outWrite(dev, frameSys([0x42, id]));
    await delay(90);
    const before = tryRead(dev, 1).data || [];
    outWrite(dev, frameSys([0x42, id, ...beU32(now)]));
    await delay(140);
    const wr = tryRead(dev, 1).data || [];
    await delay(120);
    outWrite(dev, frameSys([0x42, id]));
    await delay(90);
    const after = tryRead(dev, 1).data || [];
    console.log(`  id ${id}: before ${hex(before)}  write ${hex(wr)}  after ${hex(after)}` +
                (hex(before) !== hex(after) ? "   *** TIMESTAMP SET ***" : ""));
    if (await check(`timestamp id ${id}`)) return;
  }

  console.log(`\nNo combination set the imprinted bit (${hits} hits).`);
  console.log("Every command sent was one named in Nike's DLL; no opcode sweeping.");
}

async function imprintedBit(dev) {
  const s = await readSystem(dev, [0xdf]);
  return { raw: s, bit: s && s.length ? (s[0] & 1) : null };
}

// Brute-force imprint: sweep candidate imprint_state values, writing the config
// blob and checking whether the readable imprinted bit flips.
async function imprint(dev) {
  console.log("\n=== IMPRINT ATTEMPT (brute force, verified via status bit) ===");
  const base = await imprintedBit(dev);
  console.log(`baseline status: ${base.raw ? hex(base.raw) : "-"}  imprinted=${base.bit}`);

  const candidates = [0x00000001, 0x00000003, 0x0000000f, 0x000000ff, 0x0000ffff,
                      0xffffffff, 0x00000002, 0x00010000, 0x01000000, 0x7fffffff];
  for (const val of candidates) {
    const blob = buildConfigBlob(val, { clockAutoSet: 1 });
    console.log(`\n-- imprint_state=0x${val.toString(16).padStart(8, "0")}  blob=${blob.length}B --`);
    const acks = await writeDesktopData(dev, blob);
    console.log(`  write chunk acks: ${acks.join(" | ")}`);
    await delay(150);
    const after = await imprintedBit(dev);
    console.log(`  status after: ${after.raw ? hex(after.raw) : "-"}  imprinted=${after.bit}`);
    if (after.bit === 1) { console.log(`\n  *** IMPRINTED with imprint_state=0x${val.toString(16)} ***`); return; }
    if (after.raw && base.raw && hex(after.raw) !== hex(base.raw)) {
      console.log("  (status bytes CHANGED — the write is affecting device state)");
    }
  }
  console.log("\nNo value flipped the imprinted bit. If the status bytes never changed, the write");
  console.log("isn't landing (framing/save needed); if they changed, we're close — refine from here.");
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
    if (process.argv.includes("--readmem")) {
      const ai = process.argv.indexOf("--readmem");
      const start = parseInt(process.argv[ai + 1] || "0", 16);
      const length = parseInt(process.argv[ai + 2] || "400", 16);
      await identity(dev);
      await readMem(dev, start, length);
    } else if (process.argv.includes("--imprint2")) {
      await identity(dev);
      await imprint2(dev);
    } else if (process.argv.includes("--fuzz-activation")) {
      await identity(dev);
      await fuzzActivation(dev);
    } else if (process.argv.includes("--runstate")) {
      const ri = process.argv.indexOf("--runstate");
      const rs = process.argv[ri + 1];
      await identity(dev);
      await runState(dev, /^[01]$/.test(rs || "") ? Number(rs) : 1);
    } else if (process.argv.includes("--safe")) {
      await identity(dev);
      await safeRead(dev);
    } else if (process.argv.includes("--probe2")) {
      await identity(dev);
      await probe2(dev);
    } else if (process.argv.includes("--activate")) {
      await identity(dev);
      await activate(dev);
    } else if (process.argv.includes("--surface")) {
      const ai = process.argv.indexOf("--surface");
      const a = process.argv[ai + 1], b = process.argv[ai + 2];
      const start = a && /^[0-9a-fA-Fx]+$/.test(a) ? parseInt(a, 16) : 0x00;
      const end = b && /^[0-9a-fA-Fx]+$/.test(b) ? parseInt(b, 16) : 0xff;
      await identity(dev);
      await surfaceMap(dev, start, end);
    } else if (process.argv.includes("--commit")) {
      await identity(dev);
      await commitTest(dev);
    } else if (process.argv.includes("--ladder")) {
      await identity(dev);
      await ladder(dev);
    } else if (process.argv.includes("--xfer")) {
      const ai = process.argv.indexOf("--xfer");
      const rest = process.argv.slice(ai + 1).filter((a) => /^[0-9a-fA-F]{1,2}$/.test(a));
      const payload = rest.length ? rest.map((h) => parseInt(h, 16)) : Array.from({ length: 54 }, (_, i) => i);
      await identity(dev);
      await xferTest(dev, payload);
    } else if (process.argv.includes("--fuzzwrite")) {
      await identity(dev);
      await fuzzWriteOpcodes(dev);
    } else if (process.argv.includes("--writetest3")) {
      await identity(dev);
      await writeTest3(dev);
    } else if (process.argv.includes("--writetest2")) {
      await identity(dev);
      await writeTest2(dev);
    } else if (process.argv.includes("--writetest")) {
      await identity(dev);
      await writeTest(dev);
    } else if (process.argv.includes("--fuzz")) {
      await identity(dev);
      await fuzzWrite(dev);
    } else if (process.argv.includes("--memsweep")) {
      await identity(dev);
      await memSweep(dev);
    } else if (process.argv.includes("--imprint")) {
      await identity(dev);
      await imprint(dev);
    } else if (process.argv.includes("--status")) {
      await identity(dev);
      await readStatus(dev);
    } else if (process.argv.includes("--read-config")) {
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
