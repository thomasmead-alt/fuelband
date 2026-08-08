/* Fuelband USB connection via WebHID.

   Talks to a first-generation Nike+ FuelBand plugged in over USB, using the
   community reverse-engineered HID feature-report protocol
   (https://github.com/rbrune/fuelband-usb). The documented protocol covers
   device identity, battery, status flags, and timestamps; activity/fuel data
   was never reverse-engineered over USB, so this module reads status only.

   Requires WebHID (Chrome/Edge desktop) and a secure context (https or
   localhost). On Linux the hidraw node needs a udev rule granting access. */

(() => {
  "use strict";

  const VENDOR_ID = 0x11ac;   // Nike
  const PRODUCT_ID = 0x6565;  // FuelBand (non-SE)

  // The python reference assumed report ID 0x01 / 64-byte feature reports, but
  // the real descriptor may differ and WebHID validates strictly against it.
  // These are discovered from device.collections on connect (see prepare()).
  let REPORT_ID = 0x01;       // feature/output report id actually used
  let USE_INPUT_REPLY = false; // true if replies arrive as input reports
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const CMD = {
    firmwareVersion: [0x08],
    networkVersion: [0x06],
    protocolVersion: [0x60],
    status: [0xdf],
    modelNumber: [0xe0],
    serialNumber: [0xe1],
    hardwareRevision: [0xe2],
    battery: [0x13],
    tsDeviceInit: [0x42, 0x01],
    tsAssessmentStart: [0x42, 0x02],
    tsLastFuelReset: [0x42, 0x03],
    tsLastGoalReset: [0x42, 0x04],
  };

  let device = null;

  const supported = () => !!(navigator.hid && navigator.hid.requestDevice);

  async function connect() {
    const devices = await navigator.hid.requestDevice({
      filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }, { vendorId: VENDOR_ID }],
    });
    if (!devices.length) throw new Error("No device selected.");
    device = devices[0];
    if (!device.opened) await device.open();
    return device;
  }

  async function disconnect() {
    if (device?.opened) await device.close();
    device = null;
  }

  // Inspect the HID report descriptor WebHID exposes and pick sane defaults.
  // Prefers a feature report id shared by send+receive; otherwise falls back to
  // output-for-send / input-for-reply.
  function prepare() {
    const collections = device.collections || [];
    const feature = [], input = [], output = [];
    for (const c of collections) {
      for (const r of c.featureReports || []) feature.push(r.reportId);
      for (const r of c.inputReports || []) input.push(r.reportId);
      for (const r of c.outputReports || []) output.push(r.reportId);
    }
    if (feature.length) {
      REPORT_ID = feature[0] ?? 0x01;
      USE_INPUT_REPLY = false;
    } else if (output.length || input.length) {
      REPORT_ID = output[0] ?? input[0] ?? 0x00;
      USE_INPUT_REPLY = true;
    }
    return describe();
  }

  function describe() {
    const collections = device?.collections || [];
    const lines = [];
    lines.push(`product: ${device.productName || "(unknown)"}  vid:${(device.vendorId||0).toString(16)} pid:${(device.productId||0).toString(16)}`);
    collections.forEach((c, ci) => {
      const fmt = (r) => `id ${r.reportId} (${(r.items || []).reduce((n, it) => n + ((it.reportCount || 0) * (it.reportSize || 0)) / 8, 0)}B)`;
      lines.push(`collection ${ci} usagePage:${c.usagePage} usage:${c.usage}`);
      if (c.featureReports?.length) lines.push(`  feature: ${c.featureReports.map(fmt).join(", ")}`);
      if (c.inputReports?.length) lines.push(`  input:   ${c.inputReports.map(fmt).join(", ")}`);
      if (c.outputReports?.length) lines.push(`  output:  ${c.outputReports.map(fmt).join(", ")}`);
    });
    lines.push(`chosen: reportId ${REPORT_ID}, reply via ${USE_INPUT_REPLY ? "input report" : "feature report"}`);
    return lines.join("\n");
  }

  // Nike size-bucketed reports (confirmed from this band's descriptor and the
  // libfuelband reference): pick the smallest OUTPUT report that fits the body,
  // send [length, ...cmd], and read the reply as an INPUT report event.
  // [dataBytes, outputReportId, inputReportId]
  const BUCKETS = [[7, 9, 1], [15, 10, 2], [31, 11, 3], [63, 12, 4]];

  function pickBucket(bodyLen) {
    for (const b of BUCKETS) if (bodyLen <= b[0]) return b;
    return BUCKETS[BUCKETS.length - 1];
  }

  // Low-level exchange. Returns the raw reply { reportId, data } where data is
  // the input-report bytes (excluding the report id). Nothing is stripped, so
  // the response header can be inspected against real hardware.
  async function exchange(cmd, { timeout = 2500 } = {}) {
    if (!device?.opened) throw new Error("Not connected.");
    const body = [cmd.length, ...cmd];
    const [size, outId] = pickBucket(body.length);
    const buf = new Uint8Array(size);
    buf.set(body.slice(0, size));

    const reply = new Promise((resolve, reject) => {
      const onInput = (e) => {
        cleanup();
        resolve({
          reportId: e.reportId,
          data: new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength),
        });
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("no input-report reply (timeout)"));
      }, timeout);
      const cleanup = () => { clearTimeout(timer); device.removeEventListener("inputreport", onInput); };
      device.addEventListener("inputreport", onInput);
    });

    await device.sendReport(outId, buf);
    return reply;
  }

  // Convenience: return just the reply data bytes (still unstripped).
  async function command(cmd) {
    const { data } = await exchange(cmd);
    return data;
  }

  const ascii = (b) =>
    Array.from(b).filter((x) => x >= 0x20 && x < 0x7f).map((x) => String.fromCharCode(x)).join("").trim();

  const u32le = (b, off = 0) =>
    (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;

  const hex = (b, n) =>
    Array.from(b.subarray(0, n)).map((x) => x.toString(16).padStart(2, "0")).join(" ");

  function tsToDate(b) {
    const secs = u32le(b);
    if (!secs || secs === 0xffffffff) return null;
    return new Date(secs * 1000);
  }

  // Probe a set of candidate commands and capture the raw replies, so we can
  // read the actual response framing off real hardware rather than assume it.
  // Command bytes here follow the libfuelband style (opcode + args); the exact
  // opcodes for this firmware are what we're confirming.
  const PROBES = [
    { name: "version?", cmd: [0x08] },
    { name: "serial?", cmd: [0xe1] },
    { name: "status?", cmd: [0xdf] },
    { name: "battery?", cmd: [0x13] },
    { name: "settings?", cmd: [0x41] },
  ];

  async function probe() {
    const results = [];
    for (const p of PROBES) {
      try {
        const { reportId, data } = await exchange(p.cmd);
        results.push({ ...p, reportId, data });
      } catch (err) {
        results.push({ ...p, error: err.message });
      }
      await delay(40);
    }
    return results;
  }

  // ---------- Raw dumps (the reverse-engineering surface) ----------

  // "Desktop data" memory read — the block Nike's desktop app read.
  // libfuelband framing: cmd = [0xbb, 0x50, 0x37, 0x36, offHi, offMid, offLo].
  // The response header layout is still being confirmed, so this captures each
  // raw reply chunk (reportId + bytes) and also concatenates a best-effort
  // payload (skipping a 5-byte header) for the value scan.
  async function dumpDesktopData(maxIters = 16, headerLen = 5) {
    const chunks = [];
    const payload = [];
    let offset = 0;
    for (let i = 0; i < maxIters; i++) {
      const off = [(offset >> 16) & 0xff, (offset >> 8) & 0xff, offset & 0xff];
      const { reportId, data } = await exchange([0xbb, 0x50, 0x37, 0x36, ...off]);
      chunks.push({ reportId, data });
      for (let j = headerLen; j < data.length; j++) payload.push(data[j]);
      // Without a confirmed continuation flag, advance a fixed window and stop
      // if the band returns an empty/again-identical chunk.
      if (!data.length || data.every((x) => x === 0)) break;
      offset += 0x37;
      await delay(40);
    }
    return { chunks, payload: new Uint8Array(payload) };
  }

  // System log — ASCII text the band emits.
  async function dumpLog(maxIters = 64) {
    let text = "";
    for (let i = 0; i < maxIters; i++) {
      const { data } = await exchange([0xf6, 0x00]);
      if (!data.length) break;
      const s = ascii(data);
      if (!s) break;
      text += s;
      await delay(30);
    }
    return text;
  }

  // ---------- Decode helpers ----------

  const u16le = (b, off = 0) => (b[off] | (b[off + 1] << 8)) >>> 0;
  const u24le = (b, off = 0) => (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16)) >>> 0;

  // Scan a byte buffer for a target integer encoded little-endian as
  // 2/3/4-byte words at any offset. Returns matches [{offset, width}].
  function scanForValue(buf, target) {
    const hits = [];
    for (let i = 0; i < buf.length; i++) {
      if (i + 2 <= buf.length && u16le(buf, i) === target) hits.push({ offset: i, width: 2 });
      if (i + 3 <= buf.length && u24le(buf, i) === target) hits.push({ offset: i, width: 3 });
      if (i + 4 <= buf.length && u32le(buf, i) === target) hits.push({ offset: i, width: 4 });
    }
    return hits;
  }

  function hexDump(buf) {
    const lines = [];
    for (let i = 0; i < buf.length; i += 16) {
      const slice = buf.subarray(i, i + 16);
      const off = i.toString(16).padStart(4, "0");
      const hexPart = Array.from(slice).map((x) => x.toString(16).padStart(2, "0")).join(" ").padEnd(16 * 3 - 1, " ");
      const asciiPart = Array.from(slice).map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : "·")).join("");
      lines.push(`${off}  ${hexPart}  ${asciiPart}`);
    }
    return lines.join("\n");
  }

  // ---------- UI ----------

  const $ = (id) => document.getElementById(id);

  function row(label, value) {
    return value == null || value === ""
      ? ""
      : `<div class="dev-row"><span>${label}</span><strong>${value}</strong></div>`;
  }

  const bytesHex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join(" ");

  function renderProbe(results) {
    $("device-info").innerHTML = results
      .map((r) => {
        const val = r.error
          ? `<code>— ${r.error}</code>`
          : `<code>in#${r.reportId}: ${bytesHex(r.data)} · "${ascii(r.data) || "·"}"</code>`;
        return `<div class="dev-row"><span>${r.name} [${bytesHex(r.cmd)}]</span>${val}</div>`;
      })
      .join("");
  }

  function setStatus(text, tone = "muted") {
    const el = $("device-status");
    el.textContent = text;
    el.dataset.tone = tone;
  }

  // ---------- Decode lab ----------

  let lastDump = null;   // Uint8Array of the most recent desktop-data dump
  let lastReport = "";   // human-readable device report layout from prepare()

  function showReport(extra) {
    $("decode-lab").innerHTML =
      (extra ? `<p class="device-status" data-tone="err">${extra}</p>` : "") +
      `<p class="device-status">Device report layout — copy this back so the transport can be tuned:</p>` +
      `<pre class="hexdump">${(lastReport || "(no layout captured)").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</pre>`;
  }

  const esc = (s) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

  function renderDump(chunks = []) {
    const lab = $("decode-lab");
    const rawChunks = chunks
      .map((c, i) => `chunk ${i} (in#${c.reportId}): ${bytesHex(c.data)}`)
      .join("\n");
    if (!lastDump || !lastDump.length) {
      lab.innerHTML =
        `<p class="device-status">No payload bytes decoded, but here are the raw replies — send them to me:</p>` +
        `<pre class="hexdump">${esc(rawChunks || "(no chunks)")}</pre>`;
      return;
    }
    lab.innerHTML = `
      <div class="lab-scan">
        <label>Value shown on the band
          <input id="scan-target" type="number" min="0" placeholder="e.g. 2417" />
        </label>
        <button class="btn-ghost" id="scan-btn" type="button">Find in dump</button>
        <span class="device-status" id="scan-result"></span>
      </div>
      <pre class="hexdump" id="hexdump">${hexDump(lastDump)}</pre>
      <p class="device-status">${lastDump.length} payload bytes. Read the fuel (or steps) number off the band's display and search for it — a match tells us the offset and width of that field.</p>
      <p class="device-status">Raw chunks (send these too if the scan misses):</p>
      <pre class="hexdump">${esc(rawChunks)}</pre>
    `;
    $("scan-btn").addEventListener("click", () => {
      const target = Number($("scan-target").value);
      const res = $("scan-result");
      if (!Number.isFinite(target) || target <= 0) {
        res.textContent = "Enter a positive number first.";
        return;
      }
      const hits = scanForValue(lastDump, target);
      res.textContent = hits.length
        ? `Found at ${hits.map((h) => `offset ${h.offset} (${h.width}-byte LE)`).join(", ")}`
        : "No little-endian match. Try steps/calories, or dump again after the value changes.";
      // Highlight is left as plain text; offsets pinpoint the field for us.
    });
  }

  // Raw command tester — type command bytes (hex), see the raw reply. This is
  // how we confirm opcodes and response framing against the real band.
  function renderRawTester() {
    const el = $("raw-tester");
    el.hidden = false;
    el.innerHTML = `
      <h3>Raw command tester</h3>
      <div class="lab-scan">
        <label>Command bytes (hex)
          <input id="raw-input" type="text" placeholder="e.g. bb 50 37 36 00 00 00" />
        </label>
        <button class="btn-ghost" id="raw-send" type="button">Send</button>
      </div>
      <div class="raw-presets">
        <button class="btn-ghost" data-cmd="08" type="button">version 08</button>
        <button class="btn-ghost" data-cmd="e1" type="button">serial e1</button>
        <button class="btn-ghost" data-cmd="41" type="button">settings 41</button>
        <button class="btn-ghost" data-cmd="bb 50 37 36 00 00 00" type="button">mem-read bb 50 37 36</button>
        <button class="btn-ghost" data-cmd="f6 00" type="button">log f6 00</button>
      </div>
      <pre class="hexdump" id="raw-out">Replies appear here.</pre>
    `;
    const parse = (s) => s.trim().split(/[\s,]+/).filter(Boolean).map((h) => parseInt(h, 16))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 255);
    const send = async (bytes) => {
      const out = $("raw-out");
      if (!device) { out.textContent = "Not connected."; return; }
      if (!bytes.length) { out.textContent = "Enter at least one hex byte."; return; }
      try {
        const { reportId, data } = await exchange(bytes);
        out.textContent =
          `sent (out): ${bytesHex(bytes)}\n` +
          `reply (in#${reportId}): ${bytesHex(data)}\n` +
          `ascii: ${ascii(data) || "·"}`;
      } catch (err) {
        out.textContent = `sent (out): ${bytesHex(bytes)}\nerror: ${err.message}`;
      }
    };
    $("raw-send").addEventListener("click", () => send(parse($("raw-input").value)));
    el.querySelectorAll(".raw-presets button").forEach((b) =>
      b.addEventListener("click", () => {
        $("raw-input").value = b.dataset.cmd;
        send(parse(b.dataset.cmd));
      }));
  }

  function init() {
    const btn = $("connect-device");
    if (!supported()) {
      btn.disabled = true;
      setStatus(
        window.isSecureContext
          ? "WebHID is not available in this browser — use Chrome or Edge on desktop."
          : "USB connection needs a secure context — serve the app over https or localhost."
      );
      return;
    }
    setStatus("Plug a first-gen FuelBand into USB, then connect.");

    btn.addEventListener("click", async () => {
      if (device) {
        await disconnect();
        btn.textContent = "Connect FuelBand (USB)";
        $("device-info").innerHTML = "";
        $("decode-lab").innerHTML = "";
        $("raw-tester").innerHTML = "";
        $("raw-tester").hidden = true;
        $("dump-btn").hidden = true;
        $("log-btn").hidden = true;
        $("diag-btn").hidden = true;
        lastDump = null;
        setStatus("Disconnected.");
        return;
      }
      try {
        setStatus("Requesting device…");
        await connect();
        const report = prepare();
        console.info("fuelband device report layout:\n" + report);
        lastReport = report;
        setStatus(`Connected to ${device.productName || "FuelBand"} — probing…`);
        renderProbe(await probe());
        renderRawTester();
        setStatus("Connected. Probe replies are shown above; use the raw tester and data dump below to capture bytes so we can decode the fuel field.", "ok");
        btn.textContent = "Disconnect";
        $("dump-btn").hidden = false;
        $("log-btn").hidden = false;
        $("diag-btn").hidden = false;
      } catch (err) {
        await disconnect().catch(() => {});
        setStatus(`Connection failed: ${err.message}`, "err");
      }
    });

    $("dump-btn").addEventListener("click", async () => {
      if (!device) return;
      try {
        setStatus("Reading desktop-data block…");
        const { chunks, payload } = await dumpDesktopData();
        lastDump = payload;
        renderDump(chunks);
        setStatus(`Captured ${chunks.length} chunk(s), ${payload.length} payload bytes. Search for a number from the band's display.`, "ok");
      } catch (err) {
        setStatus(`Dump failed: ${err.message}`, "err");
        showReport(`Dump failed: ${err.message}. The band's report layout is below — send it to me and I'll tune the transport.`);
      }
    });

    $("diag-btn").addEventListener("click", () => showReport());

    $("log-btn").addEventListener("click", async () => {
      if (!device) return;
      try {
        setStatus("Reading system log…");
        const log = await dumpLog();
        $("decode-lab").innerHTML =
          `<pre class="hexdump">${log ? log.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])) : "(empty log)"}</pre>`;
        setStatus("System log read.", "ok");
      } catch (err) {
        setStatus(`Log read failed: ${err.message}`, "err");
      }
    });

    navigator.hid.addEventListener("disconnect", (ev) => {
      if (ev.device === device) {
        device = null;
        btn.textContent = "Connect FuelBand (USB)";
        $("dump-btn").hidden = true;
        $("log-btn").hidden = true;
        $("diag-btn").hidden = true;
        setStatus("Device unplugged.");
      }
    });
  }

  init();
})();
