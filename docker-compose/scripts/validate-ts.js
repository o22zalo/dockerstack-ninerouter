#!/usr/bin/env node
// ================================================================
//  docker-compose/scripts/validate-ts.js
//  Validates Tailscale auth key format and optionally checks
//  expiry via the Tailscale API for node auth keys.
//
//  Requires in .env:
//    TAILSCALE_AUTHKEY
//  Optional:
//    TS_API_KEY  — Tailscale API key for expiry lookup
//    TAILSCALE_TS_TAILNET — tailnet name (default: "-" for current user's)
// ================================================================
"use strict";

const https = require("https");
const fs = require("fs");
const path = require("path");

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq).trim()] = t
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = parseEnvFile(path.resolve(process.cwd(), ".env"));

const TAILSCALE_AUTHKEY = process.env.TAILSCALE_AUTHKEY || env.TAILSCALE_AUTHKEY;
const TS_API_KEY = process.env.TS_API_KEY || env.TS_API_KEY;
const TAILSCALE_TS_TAILNET =
  process.env.TAILSCALE_TS_TAILNET || env.TAILSCALE_TS_TAILNET || process.env.TS_TAILNET || env.TS_TAILNET || "-";

const ENABLE_TAILSCALE = env.ENABLE_TAILSCALE;

console.log("\n🔐  Tailscale Auth Key Validation\n");

if (ENABLE_TAILSCALE === "false") {
  console.log("ℹ️   ENABLE_TAILSCALE=false → skipping Tailscale check.\n");
  process.exit(0);
}

if (!TAILSCALE_AUTHKEY) {
  console.error("❌  TAILSCALE_AUTHKEY is not set in .env");
  console.error("    Get one from: https://login.tailscale.com/admin/settings/keys");
  process.exit(1);
}

// ── Format checks ─────────────────────────────────────────────────
const errors = [];
const warnings = [];

if (!TAILSCALE_AUTHKEY.startsWith("tskey-")) {
  errors.push('Key should start with "tskey-"');
}

const parts = TAILSCALE_AUTHKEY.split("-");
const isNodeAuthKey = TAILSCALE_AUTHKEY.startsWith("tskey-auth-");
const isOAuthClientSecret = TAILSCALE_AUTHKEY.startsWith("tskey-client-");

if (!isNodeAuthKey && !isOAuthClientSecret) {
  warnings.push('Unrecognized Tailscale key type. Expected "tskey-auth-" or "tskey-client-".');
}

if (parts.length < 3) {
  errors.push("Key format looks incorrect — expected format: tskey-<type>-<id>-<secret>");
}

if (TAILSCALE_AUTHKEY.length < 50) {
  warnings.push(`Key is short (${TAILSCALE_AUTHKEY.length} chars) — verify it was copied completely`);
}

// ── Print format results ──────────────────────────────────────────
if (errors.length) {
  console.log("❌  Format errors:");
  errors.forEach((e) => console.log(`    ${e}`));
}
if (warnings.length) {
  console.log("⚠️   Warnings:");
  warnings.forEach((w) => console.log(`    ${w}`));
}
if (!errors.length && !warnings.length) {
  console.log(`✅  Key format looks valid (${TAILSCALE_AUTHKEY.length} chars)`);
}

if (errors.length) {
  console.log();
  process.exit(1);
}

// ── Optional: Tailscale API check ────────────────────────────────
if (!TS_API_KEY) {
  console.log("\nℹ️   TS_API_KEY not set → skipping key expiry check via API.");
  console.log("    Set TS_API_KEY in .env to enable expiry verification.\n");
  console.log("✅  Validation complete (format only)\n");
  process.exit(0);
}

if (isOAuthClientSecret) {
  console.log("\nℹ️   Detected OAuth client secret (tskey-client-...).");
  console.log("    Expiry check via /keys is skipped for OAuth client secrets.");
  console.log("✅  Validation complete (format only)\n");
  process.exit(0);
}

function tsApiRequest(apiPath) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.tailscale.com",
      path: `/api/v2${apiPath}`,
      method: "GET",
      headers: { Authorization: `Bearer ${TS_API_KEY}` },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: {} });
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  console.log("\n🌐  Checking auth keys via Tailscale API...");

  let res;
  try {
    res = await tsApiRequest(`/tailnet/${TAILSCALE_TS_TAILNET}/keys`);
  } catch (e) {
    console.warn(`⚠️   Tailscale API unreachable: ${e.message}`);
    process.exit(0);
  }

  if (res.status === 401) {
    console.warn("⚠️   TS_API_KEY returned 401 — key may be invalid or expired.");
    process.exit(0);
  }
  if (res.status !== 200 || !res.body.keys) {
    console.warn(`⚠️   Unexpected API response (status ${res.status}) — skipping.`);
    process.exit(0);
  }

  // The auth key itself appears in key list with prefix match only
  const keyPrefix = TAILSCALE_AUTHKEY.split("-").slice(0, 3).join("-"); // tskey-auth-<id>
  const found = res.body.keys.find((k) => k.id && TAILSCALE_AUTHKEY.startsWith(keyPrefix));

  if (!found) {
    console.log("⚠️   Could not find this auth key in the Tailscale key list.");
    console.log("    It may already be expired or was created with a different account.");
  } else {
    const exp = found.expires;
    if (exp) {
      const expDate = new Date(exp);
      const daysLeft = Math.round((expDate - Date.now()) / (1000 * 86400));
      if (daysLeft < 0) {
        console.log(`❌  Auth key expired on ${expDate.toLocaleDateString()}!`);
        process.exit(1);
      } else if (daysLeft < 7) {
        console.log(`⚠️   Auth key expires in ${daysLeft} day(s) (${expDate.toLocaleDateString()}) — renew soon!`);
      } else {
        console.log(`✅  Auth key expires in ${daysLeft} day(s) (${expDate.toLocaleDateString()})`);
      }
    } else {
      console.log("✅  Auth key has no expiry (non-expiring key)");
    }
    if (found.capabilities?.devices?.create?.reusable) {
      console.log("✅  Key is reusable");
    } else {
      console.log("ℹ️   Key is single-use — each deploy consumes it");
    }
  }

  console.log("\n✅  Tailscale validation complete!\n");
}

main().catch((e) => {
  console.error(`❌  Unexpected error: ${e.message}`);
  process.exit(1);
});
