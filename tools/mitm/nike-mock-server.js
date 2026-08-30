#!/usr/bin/env node
// Fake Nike+ Connect API server — tuned for the FIRST-GENERATION FuelBand.
//
// Impersonates Nike's services so the *real* Nike+ Connect desktop app (running
// natively on a pre-Catalina Intel Mac) completes its imprint flow against
// identity WE mint. The app then writes the provisioning DDB to the band over
// USB. If the band reports imprinted=1 afterwards, activation is solved.
//
// Key facts this implementation is built on (from disassembling the client):
//  * The client sets CURLOPT_SSL_VERIFYPEER=0 and CURLOPT_SSL_VERIFYHOST=0, so
//    it does NO certificate validation. Any self-signed cert works for the API.
//    Only the setup page (opened in the system browser) needs a trusted cert.
//  * gen-1 literals: deviceType=FUELBAND, deviceString/product=FuelBand,
//    setup URL segment is "setup/" (the SE uses "setup_v2/" and FUELBAND2).
//  * DIN/UDI are 14-digit NUMERIC strings; serialNo is 16 digits. Not UUIDs.
//    We set udi === din: events/prefs/sync are keyed by UDI, access-token by
//    DIN, and the routes only ever carry one of them.
//  * Type discipline matters: the client's getStringVariable asserts isString().
//    success/status/result are the STRINGS "true"/"success"; expires_in, din,
//    udi, serialNo, upmid, plusid are strings; weight/height/dailyGoal/
//    targetValue/dateOfBirth are numbers. A number where a string is expected
//    can abort the client's thread.
//  * The URL table lives in an obfuscated embedded resource we could not
//    recover, so every route matches tolerantly (substring), ordered most-
//    specific first, with a logging catch-all.
//
// Run:  sudo node nike-mock-server.js        (443 needs root)
// Certs: run ./gen-certs.sh first. See MITM-SETUP.md.

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIR = __dirname;
const LOG = path.join(DIR, "mitm-log.txt");

// ---- Identity we mint. DIN/UDI: 14-digit numeric strings; udi === din. ------
const n14 = () => String(Math.floor(Math.random() * 9e13) + 1e13);
const DIN = n14();
const IDENTITY = {
  din: DIN,
  udi: DIN,                          // deliberately identical — see header note
  userDeviceId: DIN,
  deviceGroupConfigId: crypto.randomUUID(),
  upmId: String(Math.floor(Math.random() * 1e9)),
  accessToken: crypto.randomBytes(20).toString("hex"),
  refreshToken: crypto.randomBytes(20).toString("hex"),
  onetimetoken: crypto.randomBytes(8).toString("hex").toUpperCase(),
};
let serialNo = "4242424242424242";   // overwritten with the band's real serial

// Event state: the queue stays EMPTY until the setup page is fetched, then a
// single setup_complete is delivered until it is acked. Delivering it
// unconditionally makes the client loop on "unexpected setup complete event".
let pendingEvents = [];

console.log("Minting identity for this session:");
console.log(JSON.stringify(IDENTITY, null, 2));

function log(line) {
  try { fs.appendFileSync(LOG, line + "\n"); } catch {}
  process.stdout.write(line + "\n");
}

const SETUP_HTML = `<!doctype html><meta charset="utf-8"><title>Setup complete</title>
<body style="font:16px system-ui;padding:3em;max-width:34em">
<h1>Setup complete</h1>
<p>You can return to Nike+ Connect. If it doesn't advance, this link re-fires the
event: <a href="/__fire_setup_event">fire setup_complete</a>.</p>`;

function setupComplete() {
  pendingEvents = [{
    status: "success",
    id: "setup",
    eventType: "setup_complete",
    // payload is a JSON-encoded STRING, not an object — the client re-parses it
    payload: JSON.stringify({ dailyGoal: 2000.0, nextDailyGoal: 2000.0, band_name: "FuelBand" }),
  }];
}

// Returns [status, body, contentType]
function respond(method, url, headers, body) {
  const u = url.toLowerCase();
  let req = {};
  try { req = body ? JSON.parse(body) : {}; } catch {}
  const q = (name) => {
    const m = url.match(new RegExp("[?&]" + name + "=([^&]*)", "i"));
    return m ? decodeURIComponent(m[1]) : 0;
  };
  const J = (o) => [200, JSON.stringify(o), "application/json"];

  // --- manual event trigger (fallback if the browser leg misbehaves) --------
  if (u.includes("__fire_setup_event")) { setupComplete(); return J({ fired: "true" }); }

  // --- 1. device imprint: issue DIN/UDI. Echo the band's real serial. -------
  if (u.includes("/device/imprint") || u.includes("imprint")) {
    if (req.serialNo) serialNo = String(req.serialNo);
    return J({
      userDeviceId: IDENTITY.userDeviceId, din: IDENTITY.din, udi: IDENTITY.udi,
      deviceName: "FuelBand", deviceString: "FuelBand", serialNo,
      color: "GREEN",
      firmwareVersion: String(req.firmwareVersion || "F2.12"),
      softwareVersion: String(req.softwareVersion || "F2.12"),
      carrier: "telecom",
      deviceGroupConfigId: IDENTITY.deviceGroupConfigId,
      success: "true",
    });
  }

  // --- 3. one-time token ----------------------------------------------------
  if (u.includes("onetimetoken")) return J({ onetimetoken: IDENTITY.onetimetoken, success: "true" });

  // --- 6. ack event (before the generic /events/ match) ---------------------
  if (u.includes("/ack/")) {
    const id = url.split("/ack/")[1].split(/[?/]/)[0];
    pendingEvents = pendingEvents.filter((e) => e.id !== id);
    return J({ status: "success", events: pendingEvents });
  }

  // --- 5. event queue -------------------------------------------------------
  if (u.includes("/events/")) return J({ status: "success", events: pendingEvents });

  // --- 4. setup page (browser leg) — THIS injects the event.
  // Ordered after /events/ so the shared "connect/" substring can't collide.
  if (u.includes("/setup/") || u.includes("/setup_v2/") || u.includes("/connect/setup")) {
    setupComplete();
    log("  *** setup page fetched -> setup_complete queued ***");
    return [200, SETUP_HTML, "text/html; charset=utf-8"];
  }

  // --- 7a. device preferences. MUST precede the /me/device/ branch, since the
  // path is /v1.0/me/device/<udi>/settings and would otherwise be shadowed.
  if (u.includes("/settings")) {
    return J({ success: "true", preference: {
      FUELBANDSTEPS: 1234, FUELBANDCALORIES: 1000,
      FUELBANDFUEL: 4321, FUELBANDISLEFTORIENTATION: 1 } });
  }

  // --- 2. access token. expires_in is read as a STRING. ---------------------
  if (u.includes("getaccesstoken") || u.includes("access") || u.includes("token") ||
      (body && body.includes("grant_type"))) {
    return J({ access_token: IDENTITY.accessToken, refresh_token: IDENTITY.refreshToken,
               expires_in: "10000000", token_type: "bearer" });
  }

  // --- daily-goal list: MUST echo the requested start/end times ------------
  if (u.includes("dailygoal/list") || u.includes("dailygoal")) {
    return J({ success: "true", dailyGoalList: [{
      challengeId: "CHALLENGE", startTime: q("startTime"), endTime: q("endTime"),
      targetValue: 2000.0 }] });
  }
  if (u.includes("/challenge")) {
    return J({ success: "true", challengeId: "CHALLENGE",
      challengeType: req.challengeType || "DAILY_GOAL",
      dailyGoalDate: req.dailyGoalDate || 0, dstOffset: req.dstOffset || 0,
      targetValue: req.targetValue || 2000.0, tzOffset: req.tzOffset || 0 });
  }

  // --- 7c. profile. deviceType FUELBAND (gen-1), NOT FUELBAND2. ------------
  if (u.includes("/me/profile") || u.includes("profile")) {
    return J({ success: "true", screenName: "John", firstName: "John", lastName: "Doe",
      email: "john@example.com", weight: 70.0, height: 180.0, gender: "male",
      dateOfBirth: 315619200000, dailyGoal: 2000.0, pin: "",
      updateDate: Date.now(), initiationStart: 0, initiationTimeZoneId: "UTC",
      initiationStatus: "COMPLETE",
      deviceList: [{ deviceString: "FuelBand", deviceType: "FUELBAND",
                     din: IDENTITY.din, udi: IDENTITY.udi, serialNumber: serialNo,
                     userDeviceId: IDENTITY.userDeviceId }] });
  }

  // --- cpc profile / account: units. Anything but FT/INCHES+POUNDS => metric.
  if (u.includes("/me/account") || u.includes("account") || u.includes("cpc")) {
    return J({ success: "true", firstName: "John", heightUnit: "cm", weightUnit: "kg",
      entity: { firstName: "John", heightUnit: "cm", weightUnit: "kg" } });
  }

  // --- sync params: upmid/plusid are STRINGS -------------------------------
  if (u.includes("lasttimestamp") || u.includes("/sync")) {
    return J({ success: "true", upmid: IDENTITY.upmId, plusid: IDENTITY.upmId,
               lastSyncOffset: 0, lastSyncTimeStamp: 0 });
  }

  // --- device info (get/set). After /settings so it can't shadow it. -------
  if (u.includes("/me/device/") || u.includes("/device/")) {
    if (method === "PUT" || method === "POST") return J({ success: "true" });
    return J({ success: "true", serialNumber: serialNo, userDeviceId: IDENTITY.userDeviceId,
      din: IDENTITY.din, udi: IDENTITY.udi, deviceType: "FUELBAND",
      deviceString: "FuelBand", deviceGroupConfigId: IDENTITY.deviceGroupConfigId,
      dailyGoal: 2000.0 });
  }

  if (u.includes("summary")) return J({ success: "true", summary: {} });
  if (u.includes("remotelogs")) return [200, "OK", "text/plain"];
  if (u.includes("pin")) return J({ success: "true", pin: "" });

  // --- catch-all: the validated default, plus a server time for good measure
  return J({ success: "true", result: "success", mspServerTime: String(Date.now()) });
}

function handler(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    let code, out, ctype;
    try { [code, out, ctype] = respond(req.method, req.url, req.headers, body); }
    catch (e) { code = 200; out = JSON.stringify({ success: "true" }); ctype = "application/json";
                log("  !! handler error: " + e.message); }

    log("\n===== " + new Date().toISOString() + " =====");
    log(`${req.method} ${req.url}  (host: ${req.headers.host})`);
    if (body) log("REQ BODY: " + body);
    log(`--> ${code} ${ctype}  ${out.length > 500 ? out.slice(0, 500) + "..." : out}`);

    res.writeHead(code, { "Content-Type": ctype });
    res.end(out);
  });
}

const opts = {
  key: fs.readFileSync(path.join(DIR, "server.key")),
  cert: fs.readFileSync(path.join(DIR, "server.crt")),
};
https.createServer(opts, handler).listen(443, () => log("HTTPS mock on :443"));
http.createServer(handler).listen(80, () => log("HTTP mock on :80"));
log("Client does NOT verify certs (VERIFYPEER=0/VERIFYHOST=0) — any cert works.");
log("Logging every request to " + LOG);
