#!/usr/bin/env node
// Local GUI for FuelBand Revival.
//
// A browser page cannot talk to the band directly: WebHID only permits transfers
// on report IDs the device declares (this band declares one, and it won't read),
// and the band never emits input events. So this is a small LOCAL server — it
// serves the page, and does the USB work itself via the CLI tool.
//
// Nothing is sent anywhere. It listens on 127.0.0.1 only.
//
//   node server.js        then open http://127.0.0.1:8730

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 8730;
const DIR = __dirname;
const TOOL = path.join(DIR, "..", "fuelband-dump.js");

// Only these may be run. No arbitrary flags from the browser.
// `build` actions take user input; everything it produces is re-derived from
// values this file parses itself, so nothing from the browser reaches the
// command line as a string. `seq` runs several commands in order.
const ACTIONS = {
  status:      { args: ["--checklist"],   label: "Check band status" },
  diagnose:    { args: ["--extrareads"],  label: "Read diagnostics" },
  activate1:   { args: ["--autoimprint"], label: "Activate step 1" },
  activate2:   { args: ["--provision"],   label: "Activate step 2" },
  settings:    { args: ["--getdesktop"],  label: "Read settings record" },
  readprofile: { args: ["--readprofile"], label: "Read your details" },
  readrecord:  { args: ["--readrecord", "--json"], label: "Read what's on the band" },
  setprofile:  { build: (q) => [buildProfileArgs(q)], label: "Save your details" },
  setrecord:   { build: (q) => [buildRecordArgs(q)],  label: "Save your name" },
  saveall:     { build: buildSaveAll, label: "Save everything" },
  export:      { args: ["--export", "fuelband-export"], label: "Export activity" },
};

function buildProfileArgs(q) {
  const args = ["--setprofile"];
  const num = (k, lo, hi) => {
    const v = q.get(k);
    if (v == null || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${k} out of range`);
    return n;
  };

  const kg = num("weightKg", 2, 300);
  if (kg != null) args.push("--weight", `${kg.toFixed(1)}kg`);
  const cm = num("heightCm", 50, 260);
  if (cm != null) args.push("--height", `${cm.toFixed(1)}cm`);
  const age = num("age", 5, 120);
  if (age != null) args.push("--age", String(Math.round(age)));
  const goal = num("goal", 0, 0xffffff);
  if (goal != null) args.push("--goal", String(Math.round(goal)));

  const g = q.get("gender");
  if (g === "M" || g === "F") args.push("--gender", g);
  for (const [k, flag] of [["metric", "--metric"], ["h24", "--24h"]]) {
    const v = q.get(k);
    if (v === "0" || v === "1") args.push(flag, v);
  }

  // Clock: "now" uses this computer's time. An explicit local datetime is
  // re-formatted from parsed components, never passed through as typed.
  const clock = q.get("clock");
  if (clock === "now") args.push("--clock", "now");
  else if (clock) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(clock);
    if (!m) throw new Error("date/time not understood");
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    if (isNaN(d.getTime())) throw new Error("date/time not valid");
    const p = (n) => String(n).padStart(2, "0");
    args.push("--clock", `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
                         `T${p(d.getHours())}:${p(d.getMinutes())}`);
  }

  if (args.length === 1) throw new Error("nothing to set");
  return args;
}

// Text that goes into the band's settings record. Stripped to printable ASCII
// and length-capped — the record is fixed-width in places and the band's own
// parser is unforgiving about lengths.
function buildRecordArgs(q) {
  const args = ["--writerecord"];
  const text = (key, flag, max) => {
    const v = q.get(key);
    if (v == null || v === "") return;
    // Strip control characters, then leading dashes: the CLI treats a value
    // starting with "--" as a missing argument and would silently ignore it.
    const clean = v.replace(/[^\x20-\x7e]/g, "").replace(/^-+/, "").trim().slice(0, max);
    if (clean) args.push(flag, clean);
  };
  text("firstName", "--name", 32);
  text("bandName", "--bandname", 32);
  text("email", "--email", 64);

  const bd = q.get("birthdate");
  if (bd) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bd)) throw new Error("birthdate must be YYYY-MM-DD");
    args.push("--birthdate", bd);
  }
  for (const [k, flag] of [["weightUnits", "--weightunits"], ["heightUnits", "--heightunits"]]) {
    const v = q.get(k);
    if (v === "0" || v === "1") args.push(flag, v);
  }
  if (args.length === 1) throw new Error("nothing to set");
  return args;
}

// Both halves, in order: the settings record first, then the live options and
// the clock — matching the order the original software used.
function buildSaveAll(q) {
  const out = [];
  for (const fn of [buildRecordArgs, buildProfileArgs]) {
    try { out.push(fn(q)); } catch (e) { if (e.message !== "nothing to set") throw e; }
  }
  if (!out.length) throw new Error("nothing to set");
  return out;
}

function runAction(key, res, query) {
  const action = ACTIONS[key];
  if (!action) { res.writeHead(400); return res.end("unknown action"); }

  let runs;
  try {
    runs = action.build ? action.build(query) : [action.args];
  } catch (e) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(`Could not use those values: ${e.message}\n`);
  }

  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });

  const cwd = path.join(DIR, "..");
  let i = 0;
  const next = () => {
    if (i >= runs.length) { res.write(`\n\n--- finished ---\n`); return res.end(); }
    const argv = runs[i++];
    const child = spawn(process.execPath, [TOOL, ...argv], { cwd });
    child.stdout.on("data", (d) => res.write(d));
    child.stderr.on("data", (d) => res.write(d));
    child.on("error", (e) => { res.write(`\n[error] ${e.message}\n`); res.end(); });
    child.on("close", (code) => {
      if (runs.length > 1) res.write(`\n--- step ${i} of ${runs.length} done (exit ${code}) ---\n`);
      if (code !== 0) { res.write(`\n--- stopped: exit ${code} ---\n`); return res.end(); }
      next();
    });
  };
  next();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/") {
    const html = fs.readFileSync(path.join(DIR, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }
  if (url.pathname === "/run") {
    return runAction(url.searchParams.get("action"), res, url.searchParams);
  }
  // Hand back the two files --export just wrote. Fixed names only — the path is
  // never built from anything the browser sends.
  if (url.pathname === "/download") {
    const which = url.searchParams.get("f") === "json" ? "json" : "csv";
    const file = path.join(DIR, "..", `fuelband-export.${which}`);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end("run the export first"); }
    res.writeHead(200, {
      "Content-Type": which === "json" ? "application/json" : "text/csv",
      "Content-Disposition": `attachment; filename="fuelband-export.${which}"`,
    });
    return res.end(fs.readFileSync(file));
  }
  res.writeHead(404);
  res.end("not found");
});

// 127.0.0.1 only — never exposed to the network.
server.listen(PORT, "127.0.0.1", () => {
  const addr = `http://127.0.0.1:${PORT}`;
  console.log(`\n  FuelBand Revival — local app running\n`);
  console.log(`  Open this in your browser:  ${addr}\n`);
  console.log(`  (Leave this window open while you use it. Close it when done.)\n`);
  // Best-effort auto-open. spawn reports failure via an async 'error' event, not
  // a throw, so it MUST have a listener — otherwise an unhandled 'error' event
  // takes the whole server down on any machine without the opener.
  const opener = process.platform === "darwin" ? "open"
               : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const p = spawn(opener, [addr], {
      shell: process.platform === "win32", detached: true, stdio: "ignore",
    });
    p.on("error", () => { /* no browser opener — the printed URL is the fallback */ });
    p.unref();
  } catch { /* likewise */ }
});
