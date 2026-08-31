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
  status:    { args: ["--checklist"],   label: "Check band status" },
  diagnose:  { args: ["--extrareads"],  label: "Read diagnostics" },
  activate1: { args: ["--autoimprint"], label: "Activate step 1" },
  activate2: { args: ["--provision"],   label: "Activate step 2" },
  settings:  { args: ["--getdesktop"],  label: "Read settings record" },
};

function runAction(key, res) {
  const action = ACTIONS[key];
  if (!action) { res.writeHead(400); return res.end("unknown action"); }

  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });

  const child = spawn(process.execPath, [TOOL, ...action.args], { cwd: path.join(DIR, "..") });
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
    return runAction(url.searchParams.get("action"), res);
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
