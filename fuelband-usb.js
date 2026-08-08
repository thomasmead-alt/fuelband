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
  const REPORT_ID = 0x01;

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

  // Send [len+1, 0x07, ...cmd] as feature report 0x01, then read the reply.
  async function command(cmd) {
    if (!device?.opened) throw new Error("Not connected.");
    const payload = new Uint8Array(2 + cmd.length);
    payload[0] = cmd.length + 1;
    payload[1] = 0x07;
    payload.set(cmd, 2);
    await device.sendFeatureReport(REPORT_ID, payload);
    const view = await device.receiveFeatureReport(REPORT_ID);
    let bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    // Chrome includes the report ID as the first byte of a received feature
    // report; the python reference parses [id, len, tag, ...data]. Handle
    // both shapes by locating the 0x07/​response tag header defensively.
    if (bytes[0] === REPORT_ID) bytes = bytes.subarray(1);
    return bytes.subarray(2); // skip [len, tag]
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

  async function readInfo() {
    const info = {};
    const tryCmd = async (name, cmd, parse) => {
      try {
        info[name] = parse(await command(cmd));
      } catch (err) {
        info[name] = null;
        console.warn(`fuelband: ${name} failed`, err);
      }
    };

    await tryCmd("model", CMD.modelNumber, ascii);
    await tryCmd("serial", CMD.serialNumber, ascii);
    await tryCmd("firmware", CMD.firmwareVersion, (b) =>
      b.length >= 3 ? `${String.fromCharCode(b[0])}${b[1]}.${b[2]}` : hex(b, b.length));
    await tryCmd("hardwareRev", CMD.hardwareRevision, (b) => b[0]);
    await tryCmd("battery", CMD.battery, (b) => ({
      percent: b[0],
      charging: b[1] === 0x59, // 0x59 charging, 0x4e idle
      millivolts: b[2] | (b[3] << 8),
    }));
    await tryCmd("status", CMD.status, (b) => hex(b, 8));
    await tryCmd("deviceInit", CMD.tsDeviceInit, tsToDate);
    await tryCmd("lastFuelReset", CMD.tsLastFuelReset, tsToDate);
    await tryCmd("lastGoalReset", CMD.tsLastGoalReset, tsToDate);
    return info;
  }

  // ---------- Raw dumps (the reverse-engineering surface) ----------

  // "Desktop data" memory dump — the block Nike's desktop app read.
  // Protocol: send [0x50,0x37,0x36, off0,off1,off2]; response is
  // [status, off0,off1,off2, ...data]; loop while status === 0x01.
  async function dumpDesktopData(maxBytes = 280) {
    const out = [];
    let status = 0x01;
    let offset = [0x00, 0x00, 0x00];
    let guard = 0;
    while (status === 0x01 && guard++ < 128) {
      const d = await command([0x50, 0x37, 0x36, ...offset]);
      status = d[0];
      offset = [d[1], d[2], d[3]];
      for (let i = 4; i < d.length; i++) out.push(d[i]);
      if (out.length >= maxBytes) break;
    }
    return new Uint8Array(out.slice(0, maxBytes));
  }

  // System log — ASCII text the band emits.
  async function dumpLog(maxIters = 256) {
    let text = "";
    for (let i = 0; i < maxIters; i++) {
      const d = await command([0xf6, 0x00]);
      if (!d.length) break;
      text += ascii(d);
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

  function renderInfo(info) {
    const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
    const battery = info.battery
      ? `${info.battery.percent}% ${info.battery.charging ? "⚡ charging" : ""} (${(info.battery.millivolts / 1000).toFixed(2)} V)`
      : null;
    $("device-info").innerHTML =
      row("Model", info.model) +
      row("Serial", info.serial) +
      row("Firmware", info.firmware) +
      row("Hardware rev", info.hardwareRev) +
      row("Battery", battery) +
      row("Status flags", info.status && `<code>${info.status}</code>`) +
      row("First set up", info.deviceInit && dateFmt.format(info.deviceInit)) +
      row("Last fuel reset", info.lastFuelReset && dateFmt.format(info.lastFuelReset)) +
      row("Last goal reset", info.lastGoalReset && dateFmt.format(info.lastGoalReset));
  }

  function setStatus(text, tone = "muted") {
    const el = $("device-status");
    el.textContent = text;
    el.dataset.tone = tone;
  }

  // ---------- Decode lab ----------

  let lastDump = null; // Uint8Array of the most recent desktop-data dump

  function renderDump() {
    const lab = $("decode-lab");
    if (!lastDump || !lastDump.length) {
      lab.innerHTML = `<p class="device-status">No bytes returned. If the band shows a USB/low-battery icon, charge it fully first, then dump again.</p>`;
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
      <p class="device-status">${lastDump.length} bytes. Read the fuel (or steps) number off the band's display and search for it — a match tells us the offset and width of that field.</p>
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
        $("dump-btn").hidden = true;
        $("log-btn").hidden = true;
        lastDump = null;
        setStatus("Disconnected.");
        return;
      }
      try {
        setStatus("Requesting device…");
        await connect();
        setStatus(`Connected to ${device.productName || "FuelBand"} — reading…`);
        renderInfo(await readInfo());
        setStatus("Connected. Use the decode lab below to pull the raw data block off the band — fuel/activity aren't in a documented format yet, so we hunt for them.", "ok");
        btn.textContent = "Disconnect";
        $("dump-btn").hidden = false;
        $("log-btn").hidden = false;
      } catch (err) {
        await disconnect().catch(() => {});
        setStatus(`Connection failed: ${err.message}`, "err");
      }
    });

    $("dump-btn").addEventListener("click", async () => {
      if (!device) return;
      try {
        setStatus("Reading desktop-data block…");
        lastDump = await dumpDesktopData();
        renderDump();
        setStatus(`Dumped ${lastDump.length} bytes. Now search for a number from the band's display.`, "ok");
      } catch (err) {
        setStatus(`Dump failed: ${err.message}`, "err");
      }
    });

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
        setStatus("Device unplugged.");
      }
    });
  }

  init();
})();
