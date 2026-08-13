#!/usr/bin/env node
// Fake Nike+ Connect API server.
//
// Impersonates secure-nikeplus.nike.com so the *real* Nike+ Connect desktop app
// (running natively on a pre-Catalina Intel Mac) completes its imprint flow
// against identity WE mint. If the band then reports imprinted=1, activation is
// solved over USB with our own server. If not, the firmware validates identity
// locally and no server helps.
//
// The imprint chain (from FuelbandWebManager):
//   acquireDin -> getAccessToken -> deviceImprint -> getDevicePreferences
//   -> getEvents (returns setup_complete) -> setImprintingState
//
// We don't know every exact path, so this server LOGS every request verbatim
// (method, path, headers, body) to mitm-log.txt and answers by heuristic. Read
// the log after a run and tighten the handlers below to match reality.
//
// Run:  sudo node nike-mock-server.js        (443 needs root)
// Certs: run ./gen-certs.sh first; trust ca.crt in the System keychain.

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIR = __dirname;
const LOG = path.join(DIR, "mitm-log.txt");

// ---- The identity we hand the band. Change freely; note it to diff later. ----
const uuid = () => crypto.randomUUID();
const IDENTITY = {
  din: uuid(),
  udi: uuid(),
  deviceGroupConfigId: uuid(),
  upmId: String(Math.floor(Math.random() * 1e9)),
  accessToken: crypto.randomBytes(20).toString("hex"),
  refreshToken: crypto.randomBytes(20).toString("hex"),
};
console.log("Minting identity for this session:");
console.log(JSON.stringify(IDENTITY, null, 2));

function log(line) {
  fs.appendFileSync(LOG, line + "\n");
  process.stdout.write(line + "\n");
}

// Heuristic responder. Returns [statusCode, jsonObject|string].
function respond(method, url, headers, body) {
  const u = url.toLowerCase();
  const b = (body || "").toLowerCase();

  // OAuth token exchange
  if (u.includes("token") || b.includes("grant_type")) {
    return [200, {
      access_token: IDENTITY.accessToken,
      refresh_token: IDENTITY.refreshToken,
      token_type: "bearer",
      expires_in: 3600,
      scope: "nikeplus",
    }];
  }
  // Device registration / DIN acquisition
  if (u.includes("register") || u.includes("acquire") || u.includes("/device") ||
      u.includes("din") || u.includes("imprint")) {
    return [200, {
      din: IDENTITY.din,
      udi: IDENTITY.udi,
      deviceGroupConfigId: IDENTITY.deviceGroupConfigId,
      upmId: IDENTITY.upmId,
      serialNumber: "20M9FC5V01660",
      success: true,
    }];
  }
  // Event polling -> hand back the setup_complete event once
  if (u.includes("event")) {
    return [200, {
      events: [{ eventType: "setup_complete", udi: IDENTITY.udi }],
      eventType: "setup_complete",
    }];
  }
  // Device preferences
  if (u.includes("preference") || u.includes("profile") || u.includes("cpc")) {
    return [200, {
      accessToken: IDENTITY.accessToken,
      upmId: IDENTITY.upmId,
      goal: 2000, gender: "M", height: 180, weight: 80,
    }];
  }
  // PIN
  if (u.includes("pin")) return [200, { pin: "1234" }];

  // Default: 200 + empty object so the app keeps moving; log it so we can add a
  // precise handler next iteration.
  return [200, {}];
}

function handler(req, res) {
  let chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const [code, payload] = respond(req.method, req.url, req.headers, body);
    const out = typeof payload === "string" ? payload : JSON.stringify(payload);

    log("\n===== " + new Date().toISOString() + " =====");
    log(`${req.method} ${req.url}  (host: ${req.headers.host})`);
    log("REQ HEADERS: " + JSON.stringify(req.headers));
    if (body) log("REQ BODY: " + body);
    log(`--> ${code}  ${out}`);

    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(out);
  });
}

const opts = {
  key: fs.readFileSync(path.join(DIR, "server.key")),
  cert: fs.readFileSync(path.join(DIR, "server.crt")),
};
https.createServer(opts, handler).listen(443, () =>
  log("HTTPS mock listening on :443 (secure-nikeplus.nike.com)"));
http.createServer(handler).listen(80, () =>
  log("HTTP mock listening on :80"));
log("Logging every request to " + LOG + " — read it and tighten handlers as needed.");
