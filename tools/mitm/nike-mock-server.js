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
// DIN/UDI are 14-digit NUMERIC strings and serial is 16-digit (this is the shape
// tiferrei/fuelband's working server used and Nike+ Connect accepted — NOT UUIDs).
const n14 = () => String(Math.floor(Math.random() * 9e13) + 1e13);
const IDENTITY = {
  din: n14(),
  udi: n14(),
  userDeviceId: n14(),
  deviceGroupConfigId: crypto.randomUUID(),
  upmId: String(Math.floor(Math.random() * 1e9)),
  accessToken: crypto.randomBytes(20).toString("hex"),
  refreshToken: crypto.randomBytes(20).toString("hex"),
  onetimetoken: crypto.randomBytes(12).toString("hex"),
};
console.log("Minting identity for this session:");
console.log(JSON.stringify(IDENTITY, null, 2));

function log(line) {
  fs.appendFileSync(LOG, line + "\n");
  process.stdout.write(line + "\n");
}

// Heuristic responder. Returns [statusCode, jsonObject|string].
// Endpoint shapes reconstructed from tiferrei/fuelband's working server
// (API/server.py) — the imprint chain Nike+ Connect actually calls:
//   POST /v1.0/device/imprint  GET /v1.0/device/onetimetoken
//   GET  /plus/setup/<ott>     GET/POST /events/connect/<din>[/ack/<id>]
//   GET  /map/getAccessToken   GET /v1.0/me/profile   GET/PUT /v1.0/me/device/<din>
//   GET  /v1.0/me/sync/lasttimestamp
// deviceType is FUELBAND (gen-1), NOT FUELBAND2 (the SE, which tiferrei hardcoded).
function respond(method, url, headers, body) {
  const u = url.toLowerCase();
  const b = (body || "").toLowerCase();

  // Device imprint -> issue identity. This is the pivotal call.
  if (u.includes("/device/imprint") || u.includes("imprint")) {
    return [200, {
      userDeviceId: IDENTITY.userDeviceId,
      din: IDENTITY.din,
      udi: IDENTITY.udi,
      deviceName: "Nike+ FuelBand",
      deviceString: "FUELBAND",
      deviceType: "FUELBAND",
      serialNo: "20M9FC5V01660",
      deviceGroupConfigId: IDENTITY.deviceGroupConfigId,
      color: 0, firmwareVersion: "F2.12", softwareVersion: "F2.12", carrier: "",
      success: true,
    }];
  }
  // One-time token + setup trigger
  if (u.includes("onetimetoken")) return [200, { onetimetoken: IDENTITY.onetimetoken }];
  if (u.includes("/plus/setup/")) return [200, { status: "ok" }];

  // OAuth access token
  if (u.includes("getaccesstoken") || u.includes("token") || b.includes("grant_type")) {
    return [200, {
      access_token: IDENTITY.accessToken, refresh_token: IDENTITY.refreshToken,
      token_type: "bearer", expires_in: 3600, scope: "nikeplus",
    }];
  }
  // Event queue -> hand back setup_complete (carries dailyGoal + band_name)
  if (u.includes("/events/connect/") || u.includes("event")) {
    if (method === "POST") return [200, { status: "ok" }]; // ack
    return [200, [{
      eventId: "1", eventType: "setup_complete",
      din: IDENTITY.din, dailyGoal: 2000, band_name: "FUEL",
    }]];
  }
  // Profile / device / settings
  if (u.includes("/me/profile")) {
    return [200, { deviceList: [{ deviceString: "FUELBAND", deviceType: "FUELBAND", din: IDENTITY.din }],
                   upmId: IDENTITY.upmId, screenName: "user", firstName: "Fuel" }];
  }
  if (u.includes("/me/device/")) {
    return [200, { din: IDENTITY.din, udi: IDENTITY.udi, deviceType: "FUELBAND",
                   deviceGroupConfigId: IDENTITY.deviceGroupConfigId, dailyGoal: 2000 }];
  }
  if (u.includes("lasttimestamp")) {
    return [200, { upmid: IDENTITY.upmId, plusid: IDENTITY.upmId, lastSyncOffset: 0, lastSyncTimeStamp: 0 }];
  }
  if (u.includes("preference") || u.includes("cpc")) {
    return [200, { accessToken: IDENTITY.accessToken, upmId: IDENTITY.upmId,
                   goal: 2000, gender: "M", height: 180, weight: 80 }];
  }
  if (u.includes("challenge")) return [200, method === "POST" ? { status: "ok" } : []];
  if (u.includes("pin")) return [200, { pin: "1234" }];

  // Default: 200 + empty object so the app keeps moving; the log shows any
  // gen-1-only endpoint we then add a precise handler for.
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
