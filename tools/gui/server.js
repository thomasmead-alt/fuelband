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
const ACTIONS = {
  status:      { args: ["--checklist"],   label: "Check band status" },
  diagnose:    { args: ["--extrareads"],  label: "Read diagnostics" },
  activate1:   { args: ["--autoimprint"], label: "Activate step 1" },
  activate2:   { args: ["--provision"],   label: "Activate step 2" },
  settings:    { args: ["--getdesktop"],  label: "Read settings record" },
  readprofile: { args: ["--readprofile"], label: "Read your details" },
  setprofile:  { build: buildProfileArgs,  label: "Save your details" },
  export:      { args: ["--export", "fuelband-export"], label: "Export activity" },
};

// The only action that takes user input. Every value is re-derived from a
// number we parse ourselves — nothing the browser sends is passed through as a
// string, so there is no way to smuggle an extra flag into the command line.
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
  if (args.length === 1) throw new Error("nothing to set");
  return args;
}

function runAction(key, res, query) {
  const action = ACTIONS[key];
  if (!action) { res.writeHead(400); return res.end("unknown action"); }

  let argv;
  try {
    argv = action.build ? action.build(query) : action.args;
  } catch (e) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(`Could not use those values: ${e.message}\n`);
  }

  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });

  const child = spawn(process.execPath, [TOOL, ...argv], { cwd: path.join(DIR, "..") });
  child.stdout.on("data", (d) => res.write(d));
  child.stderr.on("data", (d) => res.write(d));
  child.on("error", (e) => { res.write(`\n[error] ${e.message}\n`); res.end(); });
  child.on("close", (code) => {
    res.write(`\n\n--- finished (exit ${code}) ---\n`);
    res.end();
  });
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
