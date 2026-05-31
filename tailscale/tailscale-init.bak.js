#!/usr/bin/env node
// ================================================================
//  tailscale/tailscale-init.js
//  Ensures tags from .env exist in Tailscale ACL tagOwners (merge-only),
//  optionally mirrors tagOwners to a local ACL JSON/HuJSON file, and
//  updates TAILSCALE_TAILNET_DOMAIN in .env from API-derived data,
//  renders tailscale/serve.json from env-derived values,
//  and enables HTTPS in Tailnet settings when not already enabled.
//
//  Usage:
//    node tailscale/tailscale-init.js .env
//    node tailscale/tailscale-init.js .env --yes
//    node tailscale/tailscale-init.js            # process.env mode
//    node tailscale/tailscale-init.js --remove-hostname
//    node tailscale/tailscale-init.js .env --remove-hostname --yes
//
//  Required in target .env (or process env):
//    TAILSCALE_CLIENTID
//      - OAuth client ID (for example: kFhHFn4CBE11CNTRL)
//    TAILSCALE_AUTHKEY
//      - OAuth client secret (tskey-client-...)
//
//  Required for default init flow:
//    TAILSCALE_TAGS
//      - Comma-separated tags to ensure exist in tagOwners
//
//  Required for --remove-hostname flow:
//    PROJECT_NAME
//      - Device hostname to remove from tailnet
//
//  Optional:
//    TAILSCALE_TS_TAILNET      - Tailnet identifier for API calls (default: -)
//    TAILSCALE_TAG_OWNERS      - Owners for newly created tags (default: autogroup:admin)
//    TAILSCALE_ACL_JSON_PATH   - Local ACL JSON/HuJSON file to merge tags into
//    TAILSCALE_SERVE_JSON_PATH - Local serve config path (default: ./tailscale/serve.json)
//    TAILSCALE_SERVE_PROXY     - Local upstream URL (default: http://127.0.0.1:80)
// ================================================================
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const readline = require("readline");

function unquote(value) {
  if (!value) return value;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseEnv(content) {
  const lines = content.split(/\r?\n/);
  const map = {};

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const eq = line.indexOf("=");
    if (eq < 0) return;

    const key = line.slice(0, eq).trim();
    const rawValue = line.slice(eq + 1).trim();
    if (!key) return;

    map[key] = {
      value: unquote(rawValue),
      lineIndex: index,
    };
  });

  return { lines, map };
}

function getEnvValue(envMap, key) {
  return envMap[key] ? envMap[key].value : "";
}

function parseCsv(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function uniqueStable(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function isTag(value) {
  return /^tag:[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

function isLikelyDomain(value) {
  if (!value) return false;
  if (value.includes("://") || value.includes("/") || /\s/.test(value)) return false;
  return /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/.test(value);
}

function normalizeTailnetDomain(value) {
  const v = (value || "").trim();
  if (!v) return "";
  if (v === "-" || v.toLowerCase() === "null" || v.toLowerCase() === "undefined") return "";
  return v;
}

function isLikelyTailnetDomain(value) {
  const clean = normalizeTailnetDomain(value).toLowerCase();
  if (!clean) return false;
  return isLikelyDomain(clean) && (clean.endsWith(".ts.net") || clean.endsWith(".beta.tailscale.net"));
}

function pickDomainFromSearchPaths(paths) {
  if (!Array.isArray(paths)) return "";
  const clean = paths.map((p) => (typeof p === "string" ? p.trim() : "")).filter(Boolean);
  return clean.find((p) => p.toLowerCase().endsWith(".ts.net")) || clean.find((p) => isLikelyDomain(p)) || "";
}

function extractDomainFromDeviceName(name) {
  if (typeof name !== "string") return "";
  const clean = name.trim().toLowerCase().replace(/\.+$/, "");
  if (!clean) return "";

  if (isLikelyTailnetDomain(clean)) return clean;

  const parts = clean.split(".");
  if (parts.length < 3) return "";
  const suffix = parts.slice(1).join(".");
  return isLikelyTailnetDomain(suffix) ? suffix : "";
}

function inferDomainFromServeConfigText(serveText, projectName) {
  if (typeof serveText !== "string" || !serveText.trim()) return "";

  let parsed;
  try {
    parsed = JSON.parse(serveText);
  } catch {
    return "";
  }

  if (!parsed || typeof parsed !== "object" || !parsed.Web || typeof parsed.Web !== "object") {
    return "";
  }

  const projectPrefix = normalizeHostLabel(projectName);
  const domains = [];
  const webHosts = Object.keys(parsed.Web);

  webHosts.forEach((entry) => {
    const label = normalizeHostLabel(entry);
    if (!label) return;
    const host = label.split(":")[0];
    if (!host) return;

    if (projectPrefix && host.startsWith(`${projectPrefix}.`)) {
      const suffix = host.slice(projectPrefix.length + 1);
      if (isLikelyTailnetDomain(suffix)) {
        domains.push(suffix);
        return;
      }
    }

    const fromHost = extractDomainFromDeviceName(host);
    if (fromHost) domains.push(fromHost);
  });

  return pickMostFrequent(domains);
}

function pickMostFrequent(items) {
  if (!items.length) return "";
  const counts = new Map();
  for (const item of items) {
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [item, count] of counts.entries()) {
    if (count > bestCount) {
      best = item;
      bestCount = count;
    }
  }
  return best;
}

function normalizeHostLabel(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function shortHostnameFromName(value) {
  const clean = normalizeHostLabel(value);
  if (!clean) return "";
  const first = clean.split(".")[0];
  return first || clean;
}

function collectDeviceHostCandidates(device) {
  if (!device || typeof device !== "object") return [];
  const candidates = [];
  const rawValues = [device.hostname, device.name, device.computedName, device.givenName, device.machineName, device.dnsName];

  rawValues.forEach((raw) => {
    const full = normalizeHostLabel(raw);
    if (!full) return;
    candidates.push(full);
    const short = shortHostnameFromName(full);
    if (short) candidates.push(short);
  });

  return uniqueStable(candidates);
}

function pickDeviceId(device) {
  if (!device || typeof device !== "object") return "";
  const id = device.nodeId || device.id || device.deviceId || "";
  return String(id).trim();
}

function formatDeviceForLog(device) {
  const id = pickDeviceId(device) || "(missing-id)";
  const hostname = device && typeof device.hostname === "string" ? device.hostname : "";
  const name = device && typeof device.name === "string" ? device.name : "";
  const label = hostname || shortHostnameFromName(name) || "(unknown-host)";
  return `${label} [${id}]`;
}

function askConfirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function apiRequestJson({ method, endpointPath, accessToken, body, extraHeaders }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const headers = {
      Accept: "application/json",
      ...extraHeaders,
    };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = https.request(
      {
        hostname: "api.tailscale.com",
        path: `/api/v2${endpointPath}`,
        method,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = null;
          }
          resolve({
            status: res.statusCode || 0,
            headers: res.headers || {},
            body: parsed,
            raw: data,
          });
        });
      },
    );

    req.on("error", reject);
    if (body !== undefined) req.write(payload);
    req.end();
  });
}

function getOAuthAccessToken(clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }).toString();

    const req = https.request(
      {
        hostname: "api.tailscale.com",
        path: "/api/v2/oauth/token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(form),
          Accept: "application/json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = null;
          }
          resolve({
            status: res.statusCode || 0,
            body: parsed,
            raw: data,
          });
        });
      },
    );

    req.on("error", reject);
    req.write(form);
    req.end();
  });
}

function mergeTagOwners(policyObject, requiredTags, defaultOwners) {
  if (!policyObject || typeof policyObject !== "object" || Array.isArray(policyObject)) {
    throw new Error("ACL policy is not a JSON object.");
  }

  const next = { ...policyObject };
  const currentOwners = next.tagOwners && typeof next.tagOwners === "object" && !Array.isArray(next.tagOwners) ? { ...next.tagOwners } : {};

  const addedTags = [];
  for (const tag of requiredTags) {
    if (currentOwners[tag]) continue;
    currentOwners[tag] = [...defaultOwners];
    addedTags.push(tag);
  }

  if (addedTags.length > 0) {
    next.tagOwners = currentOwners;
  }

  return {
    nextPolicy: next,
    addedTags,
  };
}

function stripJsonComments(input) {
  let output = "";
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (inString) {
      output += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      output += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }

    output += ch;
    i += 1;
  }

  return output;
}

function removeTrailingCommas(input) {
  let output = "";
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < input.length) {
    const ch = input[i];

    if (inString) {
      output += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      output += ch;
      i += 1;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j += 1;
      if (input[j] === "]" || input[j] === "}") {
        i += 1;
        continue;
      }
    }

    output += ch;
    i += 1;
  }

  return output;
}

function parseJsonOrHujson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const noComments = stripJsonComments(text);
    const noTrailingCommas = removeTrailingCommas(noComments);
    return JSON.parse(noTrailingCommas);
  }
}

function upsertEnvLine(lines, envMap, key, value) {
  const newLine = `${key}=${value}`;
  const existing = envMap[key];

  if (existing) {
    lines[existing.lineIndex] = newLine;
    return;
  }

  if (lines.length && lines[lines.length - 1].trim() !== "") {
    lines.push("");
  }
  lines.push(newLine);
}

function printList(header, values) {
  if (!values.length) return;
  console.log(header);
  values.forEach((v) => console.log(`    - ${v}`));
  console.log();
}

function isLikelyHttpUrl(value) {
  if (!value || typeof value !== "string") return false;
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (!u.hostname) return false;
    return true;
  } catch {
    return false;
  }
}

function renderServeConfigText(hostname, proxyUrl, eol = "\n") {
  const body = {
    TCP: {
      443: {
        HTTPS: true,
      },
    },
    Web: {
      [`${hostname}:443`]: {
        Handlers: {
          "/": {
            Proxy: proxyUrl,
          },
        },
      },
    },
  };

  return `${JSON.stringify(body, null, 2)}${eol}`;
}

async function main() {
  const args = process.argv.slice(2);
  const removeHostnameMode = args.includes("--remove-hostname");
  const envPathArg = args.find((arg) => !arg.startsWith("-")) || "";
  const autoYes = args.includes("--yes") || args.includes("-y");

  const envLines = [];
  const envMap = {};
  let envPath = "";
  let envPathDisplay = "(process.env only)";
  let envEol = "\n";
  let envHadTrailingNewline = false;
  let hasEnvFile = false;

  if (envPathArg) {
    envPath = path.resolve(process.cwd(), envPathArg);
    if (!fs.existsSync(envPath)) {
      console.error(`❌  Env file not found: ${envPath}`);
      process.exit(1);
    }

    const rawEnv = fs.readFileSync(envPath, "utf-8");
    envEol = rawEnv.includes("\r\n") ? "\r\n" : "\n";
    envHadTrailingNewline = rawEnv.endsWith("\n");

    const parsedEnv = parseEnv(rawEnv);
    envLines.push(...parsedEnv.lines);
    Object.assign(envMap, parsedEnv.map);

    envPathDisplay = envPath;
    hasEnvFile = true;
  }

  const warnings = [];
  const errors = [];
  const inputValue = (key) => process.env[key] || getEnvValue(envMap, key);

  const tailscaleAuthKey = inputValue("TAILSCALE_AUTHKEY").trim();
  const tailscaleClientId = inputValue("TAILSCALE_CLIENTID").trim();
  const tailnetFromNew = inputValue("TAILSCALE_TS_TAILNET");
  const tailnetFromLegacy = inputValue("TS_TAILNET");
  const tailnet = tailnetFromNew || tailnetFromLegacy || "-";
  const projectName = inputValue("PROJECT_NAME").trim();
  const existingTailnetDomainRaw = inputValue("TAILSCALE_TAILNET_DOMAIN");
  const existingTailnetDomain = normalizeTailnetDomain(existingTailnetDomainRaw);
  const aclFilePathRaw = inputValue("TAILSCALE_ACL_JSON_PATH");
  const serveFilePathRaw = (inputValue("TAILSCALE_SERVE_JSON_PATH") || "./tailscale/serve.json").trim();
  const serveProxy = (inputValue("TAILSCALE_SERVE_PROXY") || "http://127.0.0.1:80").trim();

  const requiredTagsRaw = parseCsv(inputValue("TAILSCALE_TAGS"));
  const requiredTags = uniqueStable(requiredTagsRaw.filter(isTag));
  const invalidTags = uniqueStable(requiredTagsRaw.filter((t) => !isTag(t)));

  const defaultOwnersRaw = parseCsv(inputValue("TAILSCALE_TAG_OWNERS") || "autogroup:admin");
  const defaultOwners = uniqueStable(defaultOwnersRaw.filter(Boolean));

  if (!tailscaleAuthKey) {
    errors.push("Missing TAILSCALE_AUTHKEY.");
  } else if (!tailscaleAuthKey.startsWith("tskey-client-")) {
    warnings.push("TAILSCALE_AUTHKEY should be tskey-client-... for tailscale-init API flow.");
  }

  if (!tailscaleClientId) {
    errors.push("Missing TAILSCALE_CLIENTID.");
  }
  if (tailscaleClientId && !/^[A-Za-z0-9]+$/.test(tailscaleClientId)) {
    warnings.push(`TAILSCALE_CLIENTID contains unusual characters: ${tailscaleClientId}`);
  }

  if (!tailnet) {
    errors.push("Unable to determine tailnet value (TAILSCALE_TS_TAILNET).");
  }

  if (!tailnetFromNew && tailnetFromLegacy) {
    warnings.push("Using deprecated TS_TAILNET. Please migrate to TAILSCALE_TS_TAILNET.");
  }

  if (removeHostnameMode) {
    if (!projectName) {
      errors.push("Missing PROJECT_NAME. --remove-hostname requires PROJECT_NAME in process.env or .env.");
    }
  } else {
    if (!projectName) {
      errors.push("Missing PROJECT_NAME. Required to generate tailscale serve hostname.");
    }
    if (!requiredTags.length) {
      errors.push("TAILSCALE_TAGS is empty or invalid. Provide one or more tags (example: tag:ci,tag:container).");
    }
    if (invalidTags.length) {
      warnings.push(`Ignoring invalid tag format(s): ${invalidTags.join(", ")}`);
    }
    if (!defaultOwners.length) {
      errors.push("TAILSCALE_TAG_OWNERS is empty. Example: autogroup:admin");
    }
  }

  if (existingTailnetDomain && !isLikelyTailnetDomain(existingTailnetDomain)) {
    warnings.push(`TAILSCALE_TAILNET_DOMAIN may be invalid (expected *.ts.net): ${existingTailnetDomainRaw}`);
  }
  if (!removeHostnameMode && !isLikelyHttpUrl(serveProxy)) {
    errors.push(`TAILSCALE_SERVE_PROXY is invalid: ${serveProxy}`);
  }

  console.log(`\n🔧  Tailscale Init ${removeHostnameMode ? "(remove-hostname)" : "(merge-only)"}\n`);
  console.log(`    Env file : ${envPathDisplay}`);
  console.log(`    Tailnet  : ${tailnet}`);
  if (removeHostnameMode) {
    console.log(`    Hostname : ${projectName}\n`);
  } else {
    console.log(`    Tags(env): ${requiredTags.join(", ")}\n`);
  }

  if (errors.length) {
    printList("❌  Cannot continue:", errors);
    if (warnings.length) printList("⚠️   Warnings:", warnings);
    process.exit(1);
  }

  if (warnings.length) printList("⚠️   Pre-check warnings:", warnings);

  let accessToken = "";
  try {
    const tokenRes = await getOAuthAccessToken(tailscaleClientId, tailscaleAuthKey);
    if (tokenRes.status === 200 && tokenRes.body && tokenRes.body.access_token) {
      accessToken = tokenRes.body.access_token;
    } else if (tokenRes.status === 400) {
      errors.push("OAuth token request failed (400). Check TAILSCALE_CLIENTID + TAILSCALE_AUTHKEY format.");
    } else if (tokenRes.status === 401 || tokenRes.status === 403) {
      errors.push("OAuth token request was unauthorized. Verify TAILSCALE_CLIENTID + TAILSCALE_AUTHKEY.");
    } else {
      errors.push(`OAuth token request failed: HTTP ${tokenRes.status}.`);
    }
  } catch (err) {
    errors.push(`Failed to request OAuth access token: ${err.message}`);
  }

  if (!accessToken) {
    printList("❌  API fetch failed:", errors);
    process.exit(1);
  }

  const encodedTailnet = encodeURIComponent(tailnet);

  if (removeHostnameMode) {
    let devices = [];
    try {
      const devicesRes = await apiRequestJson({
        method: "GET",
        endpointPath: `/tailnet/${encodedTailnet}/devices`,
        accessToken,
      });

      if (devicesRes.status === 200) {
        if (devicesRes.body && Array.isArray(devicesRes.body.devices)) {
          devices = devicesRes.body.devices;
        } else if (Array.isArray(devicesRes.body)) {
          devices = devicesRes.body;
        } else {
          errors.push("Unexpected devices response shape from Tailscale API.");
        }
      } else if (devicesRes.status === 401) {
        errors.push("Unauthorized (401) when reading devices. Check OAuth credential scopes.");
      } else if (devicesRes.status === 403) {
        errors.push("Forbidden (403) when reading devices. Missing scope: devices:core:read.");
      } else {
        errors.push(`Failed to read devices: HTTP ${devicesRes.status}.`);
      }
    } catch (err) {
      errors.push(`Failed to read devices: ${err.message}`);
    }

    if (errors.length) {
      printList("❌  Cannot continue:", errors);
      if (warnings.length) printList("⚠️   Warnings:", warnings);
      process.exit(1);
    }

    const targetHostname = normalizeHostLabel(projectName);
    const matchedDevices = devices.filter((device) => collectDeviceHostCandidates(device).includes(targetHostname));

    if (!matchedDevices.length) {
      console.log(`✅  No device matched hostname "${projectName}". Nothing to remove.`);
      if (warnings.length) printList("⚠️   Warnings:", warnings);
      console.log();
      process.exit(0);
    }

    console.log("Planned changes:");
    console.log(`  - Remove ${matchedDevices.length} device(s) matching hostname "${projectName}":`);
    matchedDevices.forEach((device) => {
      console.log(`      - ${formatDeviceForLog(device)}`);
    });
    console.log();

    if (warnings.length) printList("⚠️   Warnings:", warnings);

    let approved = autoYes;
    if (!approved) {
      if (!process.stdin.isTTY) {
        console.error("❌  Confirmation required but no interactive TTY available.");
        console.error("    Re-run with --yes to apply non-interactively.\n");
        process.exit(1);
      }
      const answer = await askConfirm("Remove these device(s)? (y/N): ");
      approved = answer === "y" || answer === "yes";
    }

    if (!approved) {
      console.log("\nℹ️   Cancelled. No changes applied.\n");
      process.exit(0);
    }

    let removedCount = 0;
    const removeErrors = [];
    const removeWarnings = [];

    for (const device of matchedDevices) {
      const deviceId = pickDeviceId(device);
      const deviceLabel = formatDeviceForLog(device);
      if (!deviceId) {
        removeErrors.push(`Missing device id: ${deviceLabel}`);
        continue;
      }

      try {
        const deleteRes = await apiRequestJson({
          method: "DELETE",
          endpointPath: `/device/${encodeURIComponent(deviceId)}`,
          accessToken,
        });

        if (deleteRes.status === 200 || deleteRes.status === 202 || deleteRes.status === 204) {
          removedCount += 1;
          console.log(`✅  Removed device: ${deviceLabel}`);
          continue;
        }

        if (deleteRes.status === 404) {
          removeWarnings.push(`Device already removed or not found: ${deviceLabel}`);
          continue;
        }

        if (deleteRes.status === 401) {
          removeErrors.push(`Unauthorized (401) while removing ${deviceLabel}.`);
          continue;
        }

        if (deleteRes.status === 403) {
          removeErrors.push(`Forbidden (403) while removing ${deviceLabel}. Missing scope: devices:core.`);
          continue;
        }

        const apiMessage = deleteRes.body && typeof deleteRes.body.message === "string" ? ` ${deleteRes.body.message}` : "";
        removeErrors.push(`Failed to remove ${deviceLabel}: HTTP ${deleteRes.status}.${apiMessage}`);
      } catch (err) {
        removeErrors.push(`Failed to remove ${deviceLabel}: ${err.message}`);
      }
    }

    if (removeWarnings.length) printList("⚠️   Remove warnings:", removeWarnings);

    if (removeErrors.length) {
      printList("❌  Remove failed:", removeErrors);
      process.exit(1);
    }

    console.log(`\n✅  Removed ${removedCount} device(s) matching hostname "${projectName}".\n`);
    process.exit(0);
  }

  let remotePolicy = null;
  let remotePolicyETag = "";
  let remoteAddedTags = [];
  let remoteNextPolicy = null;
  let apiTailnetDomain = "";
  let apiTailnetDomainSource = "";
  let shouldEnableHttps = false;
  let currentHttpsEnabled = null;

  try {
    const aclRes = await apiRequestJson({
      method: "GET",
      endpointPath: `/tailnet/${encodedTailnet}/acl`,
      accessToken,
    });

    if (aclRes.status === 200 && aclRes.body && typeof aclRes.body === "object") {
      remotePolicy = aclRes.body;
      remotePolicyETag = aclRes.headers.etag || "";
      const merged = mergeTagOwners(remotePolicy, requiredTags, defaultOwners);
      remoteAddedTags = merged.addedTags;
      remoteNextPolicy = merged.nextPolicy;
    } else if (aclRes.status === 401) {
      errors.push("Unauthorized (401) when reading ACL. Check OAuth credential scopes.");
    } else if (aclRes.status === 403) {
      errors.push("Forbidden (403) when reading ACL. OAuth token needs policy_file:read scope.");
    } else {
      errors.push(`Failed to read ACL: HTTP ${aclRes.status}.`);
    }
  } catch (err) {
    errors.push(`Failed to read ACL: ${err.message}`);
  }

  // Try multiple sources to infer tailnet domain.
  // 1) DNS search paths
  try {
    const dnsRes = await apiRequestJson({
      method: "GET",
      endpointPath: `/tailnet/${encodedTailnet}/dns/searchpaths`,
      accessToken,
    });

    if (dnsRes.status === 200) {
      const searchPaths = Array.isArray(dnsRes.body && dnsRes.body.searchPaths)
        ? dnsRes.body.searchPaths
        : Array.isArray(dnsRes.body)
          ? dnsRes.body
          : null;

      if (!searchPaths) {
        warnings.push("dns/searchpaths returned unexpected response shape (missing searchPaths array).");
      } else {
        const candidate = pickDomainFromSearchPaths(searchPaths);
        if (candidate) {
          apiTailnetDomain = candidate;
          apiTailnetDomainSource = "dns/searchpaths";
        } else {
          warnings.push("dns/searchpaths returned no tailnet domain (empty list or no *.ts.net entry).");
        }
      }
    } else if (dnsRes.status === 401) {
      warnings.push("Cannot read dns/searchpaths (401). Missing or invalid DNS read scope.");
    } else if (dnsRes.status === 403) {
      warnings.push("Cannot read dns/searchpaths (403). OAuth token likely missing dns:read scope.");
    } else {
      warnings.push(`dns/searchpaths returned HTTP ${dnsRes.status}.`);
    }
  } catch (err) {
    warnings.push(`dns/searchpaths request failed: ${err.message}`);
  }

  // 2) Full DNS configuration
  if (!apiTailnetDomain) {
    try {
      const dnsCfgRes = await apiRequestJson({
        method: "GET",
        endpointPath: `/tailnet/${encodedTailnet}/dns/configuration`,
        accessToken,
      });

      if (dnsCfgRes.status === 200 && dnsCfgRes.body && typeof dnsCfgRes.body === "object") {
        const cfgSearchPaths = Array.isArray(dnsCfgRes.body.searchPaths)
          ? dnsCfgRes.body.searchPaths
          : Array.isArray(dnsCfgRes.body.preferences && dnsCfgRes.body.preferences.searchPaths)
            ? dnsCfgRes.body.preferences.searchPaths
            : Array.isArray(dnsCfgRes.body.configuration && dnsCfgRes.body.configuration.searchPaths)
              ? dnsCfgRes.body.configuration.searchPaths
              : null;
        const candidate = pickDomainFromSearchPaths(cfgSearchPaths);

        if (candidate) {
          apiTailnetDomain = candidate;
          apiTailnetDomainSource = "dns/configuration";
        } else {
          const topLevelKeys = Object.keys(dnsCfgRes.body);
          warnings.push(`dns/configuration did not include a usable tailnet search path (keys: ${topLevelKeys.join(", ") || "(none)"}).`);
        }
      } else if (dnsCfgRes.status === 401) {
        warnings.push("Cannot read dns/configuration (401). Missing or invalid DNS read scope.");
      } else if (dnsCfgRes.status === 403) {
        warnings.push("Cannot read dns/configuration (403). OAuth token likely missing dns:read scope.");
      } else {
        warnings.push(`dns/configuration returned HTTP ${dnsCfgRes.status}.`);
      }
    } catch (err) {
      warnings.push(`dns/configuration request failed: ${err.message}`);
    }
  }

  // 3) Device MagicDNS names
  if (!apiTailnetDomain) {
    try {
      const devicesRes = await apiRequestJson({
        method: "GET",
        endpointPath: `/tailnet/${encodedTailnet}/devices`,
        accessToken,
      });

      if (devicesRes.status === 200) {
        const apiDevices = Array.isArray(devicesRes.body && devicesRes.body.devices)
          ? devicesRes.body.devices
          : Array.isArray(devicesRes.body)
            ? devicesRes.body
            : null;

        if (!apiDevices) {
          warnings.push("devices endpoint returned unexpected response shape (missing devices array).");
          // Skip candidate inference on malformed shape.
        } else if (!apiDevices.length) {
          warnings.push("devices endpoint returned 0 devices; cannot infer domain from device names.");
        }

        const domains = (apiDevices || [])
          .map((d) => [
            extractDomainFromDeviceName(d && d.name),
            extractDomainFromDeviceName(d && d.dnsName),
            extractDomainFromDeviceName(d && d.hostname),
          ])
          .flat()
          .filter(Boolean);
        const candidate = pickMostFrequent(domains);
        if (candidate) {
          apiTailnetDomain = candidate;
          apiTailnetDomainSource = "devices.name/dnsName";
        } else if (apiDevices && apiDevices.length) {
          warnings.push("devices endpoint had entries, but no device name exposed a tailnet domain.");
        }
      } else if (devicesRes.status === 401) {
        warnings.push("Cannot read devices (401). Missing or invalid devices:core:read scope.");
      } else if (devicesRes.status === 403) {
        warnings.push("Cannot read devices (403). OAuth token likely missing devices:core:read scope.");
      } else {
        warnings.push(`devices endpoint returned HTTP ${devicesRes.status}.`);
      }
    } catch (err) {
      warnings.push(`devices request failed: ${err.message}`);
    }
  }

  // 4) Tailnet HTTPS setting (enable if currently disabled)
  try {
    const settingsRes = await apiRequestJson({
      method: "GET",
      endpointPath: `/tailnet/${encodedTailnet}/settings`,
      accessToken,
    });

    if (settingsRes.status === 200 && settingsRes.body && typeof settingsRes.body === "object") {
      currentHttpsEnabled = settingsRes.body.httpsEnabled === true;
      shouldEnableHttps = !currentHttpsEnabled;
    } else if (settingsRes.status === 401) {
      errors.push("Unauthorized (401) when reading tailnet settings. OAuth token needs networking settings read access.");
    } else if (settingsRes.status === 403) {
      errors.push("Forbidden (403) when reading tailnet settings. Missing scope: networking_settings:read.");
    } else {
      errors.push(`Failed to read tailnet settings: HTTP ${settingsRes.status}.`);
    }
  } catch (err) {
    errors.push(`Failed to read tailnet settings: ${err.message}`);
  }

  if (errors.length) {
    printList("❌  API fetch failed:", errors);
    if (warnings.length) printList("⚠️   Additional warnings:", warnings);
    process.exit(1);
  }

  // Optional local ACL file merge (only plan here, write after confirm).
  let aclFileResolved = "";
  let aclFileObject = null;
  let aclFileAddedTags = [];
  let aclFileEol = "\n";
  let aclFileHadTrailingNewline = false;
  let aclFileExists = false;

  if (aclFilePathRaw) {
    aclFileResolved = path.resolve(process.cwd(), aclFilePathRaw);
    aclFileExists = fs.existsSync(aclFileResolved);

    if (!aclFileExists) {
      warnings.push(`TAILSCALE_ACL_JSON_PATH not found: ${aclFileResolved}`);
    } else {
      try {
        const aclText = fs.readFileSync(aclFileResolved, "utf-8");
        aclFileEol = aclText.includes("\r\n") ? "\r\n" : "\n";
        aclFileHadTrailingNewline = aclText.endsWith("\n");
        aclFileObject = parseJsonOrHujson(aclText);

        const mergedFile = mergeTagOwners(aclFileObject, requiredTags, defaultOwners);
        aclFileAddedTags = mergedFile.addedTags;
        aclFileObject = mergedFile.nextPolicy;
      } catch (err) {
        warnings.push(`Cannot parse local ACL file as JSON/HuJSON: ${aclFileResolved} (${err.message})`);
        aclFileObject = null;
      }
    }
  }

  if (!apiTailnetDomain && isLikelyTailnetDomain(tailnet)) {
    apiTailnetDomain = normalizeTailnetDomain(tailnet);
    apiTailnetDomainSource = "TAILSCALE_TS_TAILNET";
    warnings.push(`Using TAILSCALE_TS_TAILNET as tailnet domain fallback: ${apiTailnetDomain}.`);
  }

  if (!apiTailnetDomain) {
    const servePathForInfer = path.resolve(process.cwd(), serveFilePathRaw);
    if (fs.existsSync(servePathForInfer)) {
      try {
        const serveText = fs.readFileSync(servePathForInfer, "utf-8");
        const serveDomain = inferDomainFromServeConfigText(serveText, projectName);
        if (serveDomain) {
          if (!existingTailnetDomain || !isLikelyTailnetDomain(existingTailnetDomain)) {
            apiTailnetDomain = serveDomain;
            apiTailnetDomainSource = "serve.json";
            warnings.push(`Using tailnet domain inferred from ${serveFilePathRaw}: ${serveDomain}.`);
          } else if (serveDomain !== existingTailnetDomain) {
            apiTailnetDomain = serveDomain;
            apiTailnetDomainSource = "serve.json";
            warnings.push(
              `TAILSCALE_TAILNET_DOMAIN differs from ${serveFilePathRaw} (env=${existingTailnetDomain}, serve=${serveDomain}). Using serve value.`,
            );
          } else {
            apiTailnetDomain = existingTailnetDomain;
            apiTailnetDomainSource = "serve.json";
          }
        }
      } catch (err) {
        warnings.push(`Cannot read ${serveFilePathRaw} for tailnet domain fallback: ${err.message}`);
      }
    }
  }

  if (!apiTailnetDomain) {
    if (existingTailnetDomain && isLikelyTailnetDomain(existingTailnetDomain)) {
      apiTailnetDomain = existingTailnetDomain;
      apiTailnetDomainSource = "env:TAILSCALE_TAILNET_DOMAIN";
      warnings.push(`Could not infer TAILSCALE_TAILNET_DOMAIN from Tailscale API; using existing env value (unverified): ${existingTailnetDomain}.`);
    } else {
      errors.push(
        "Could not infer TAILSCALE_TAILNET_DOMAIN from Tailscale API (tried: dns/searchpaths, dns/configuration, devices). Set TAILSCALE_TAILNET_DOMAIN manually from Tailscale Admin DNS settings.",
      );
    }
  }

  if (errors.length) {
    printList("❌  Cannot continue:", errors);
    if (warnings.length) printList("⚠️   Additional warnings:", warnings);
    process.exit(1);
  }

  const envUpdates = [];
  if (apiTailnetDomain && apiTailnetDomain !== existingTailnetDomain) {
    envUpdates.push({
      key: "TAILSCALE_TAILNET_DOMAIN",
      before: normalizeTailnetDomain(existingTailnetDomainRaw) || "(missing)",
      after: apiTailnetDomain,
    });
  }

  const serveHostname = `${projectName}.${apiTailnetDomain}`;
  const servePathResolved = path.resolve(process.cwd(), serveFilePathRaw);
  let serveFileExists = fs.existsSync(servePathResolved);
  let serveFileCurrentText = "";
  let serveFileEol = "\n";

  if (serveFileExists) {
    try {
      serveFileCurrentText = fs.readFileSync(servePathResolved, "utf-8");
      serveFileEol = serveFileCurrentText.includes("\r\n") ? "\r\n" : "\n";
    } catch (err) {
      errors.push(`Cannot read serve config file: ${servePathResolved} (${err.message})`);
    }
  }

  if (errors.length) {
    printList("❌  Cannot continue:", errors);
    if (warnings.length) printList("⚠️   Additional warnings:", warnings);
    process.exit(1);
  }

  const serveFileExpectedText = renderServeConfigText(serveHostname, serveProxy, serveFileEol);
  const hasServeFileUpdate = !serveFileExists || serveFileCurrentText !== serveFileExpectedText;

  const hasRemoteUpdate = remoteAddedTags.length > 0;
  const hasAclFileUpdate = aclFileAddedTags.length > 0;
  const hasEnvUpdate = envUpdates.length > 0;
  const hasEnvFileUpdate = hasEnvFile && hasEnvUpdate;
  const hasHttpsUpdate = shouldEnableHttps;

  if (apiTailnetDomainSource === "serve.json" && !hasEnvUpdate) {
    const noisyPrefixes = [
      "dns/searchpaths returned no tailnet domain",
      "dns/configuration did not include a usable tailnet search path",
      "devices endpoint returned 0 devices",
    ];
    for (let i = warnings.length - 1; i >= 0; i -= 1) {
      const msg = warnings[i] || "";
      if (noisyPrefixes.some((prefix) => msg.startsWith(prefix))) {
        warnings.splice(i, 1);
      }
    }
  }

  if (!hasEnvFile && hasEnvUpdate) {
    warnings.push("TAILSCALE_TAILNET_DOMAIN was inferred, but no .env path was provided (skipping file update).");
  }

  if (!hasRemoteUpdate && !hasAclFileUpdate && !hasEnvFileUpdate && !hasHttpsUpdate && !hasServeFileUpdate) {
    console.log("✅  No changes needed.");
    if (!hasEnvFile && hasEnvUpdate) {
      envUpdates.forEach((u) => {
        console.log(`ℹ️   Inferred ${u.key}=${u.after} (not persisted).`);
      });
      console.log();
    }
    if (warnings.length) printList("⚠️   Warnings:", warnings);
    console.log();
    process.exit(0);
  }

  console.log("Planned changes:");
  if (hasRemoteUpdate) {
    console.log("  - Remote Tailscale ACL:");
    console.log(`      Add missing tagOwners for: ${remoteAddedTags.join(", ")}`);
    console.log("      Existing ACL rules/fields are preserved.");
  }
  if (hasAclFileUpdate) {
    console.log(`  - Local ACL file (${aclFilePathRaw}):`);
    console.log(`      Add missing tagOwners for: ${aclFileAddedTags.join(", ")}`);
    console.log("      Existing config keys are preserved.");
  }
  if (hasEnvUpdate) {
    envUpdates.forEach((u) => {
      console.log(`  - ${u.key}`);
      console.log(`      from: ${u.before}`);
      console.log(`      to  : ${u.after}`);
      if (apiTailnetDomainSource) {
        console.log(`      via : ${apiTailnetDomainSource}`);
      }
      if (!hasEnvFile) {
        console.log("      note: no .env path provided, value will not be persisted");
      }
    });
  }
  if (hasHttpsUpdate) {
    console.log("  - Tailnet HTTPS:");
    console.log(`      from: ${currentHttpsEnabled === true ? "enabled" : "disabled"}`);
    console.log("      to  : enabled");
  }
  if (hasServeFileUpdate) {
    console.log(`  - Serve config file (${serveFilePathRaw}):`);
    console.log(`      host : ${serveHostname}:443`);
    console.log(`      proxy: ${serveProxy}`);
    console.log(`      path : ${servePathResolved}`);
    console.log(`      mode : ${serveFileExists ? "update" : "create"}`);
  }
  console.log();

  if (warnings.length) printList("⚠️   Warnings:", warnings);

  let approved = autoYes;
  if (!approved) {
    if (!process.stdin.isTTY) {
      console.error("❌  Confirmation required but no interactive TTY available.");
      console.error("    Re-run with --yes to apply non-interactively.\n");
      process.exit(1);
    }
    const answer = await askConfirm("Apply these changes? (y/N): ");
    approved = answer === "y" || answer === "yes";
  }

  if (!approved) {
    console.log("\nℹ️   Cancelled. No changes applied.\n");
    process.exit(0);
  }

  // 1) Update remote ACL first.
  if (hasRemoteUpdate) {
    const headers = {};
    if (remotePolicyETag) headers["If-Match"] = remotePolicyETag;

    const postRes = await apiRequestJson({
      method: "POST",
      endpointPath: `/tailnet/${encodedTailnet}/acl`,
      accessToken,
      body: remoteNextPolicy,
      extraHeaders: headers,
    });

    if (postRes.status !== 200) {
      console.error(`\n❌  Failed to update remote ACL (HTTP ${postRes.status}).`);
      if (postRes.body && postRes.body.message) {
        console.error(`    ${postRes.body.message}`);
      }
      console.error("    No local file/.env changes were applied after this failure.\n");
      process.exit(1);
    }
    console.log(`✅  Remote ACL updated. Added tags: ${remoteAddedTags.join(", ")}`);
  }

  // 2) Update local ACL file if configured and parsable.
  if (hasAclFileUpdate && aclFileResolved && aclFileObject) {
    let localContent = JSON.stringify(aclFileObject, null, 2);
    if (aclFileHadTrailingNewline) localContent += aclFileEol;
    fs.writeFileSync(aclFileResolved, localContent, "utf-8");
    console.log(`✅  Local ACL file updated: ${aclFilePathRaw}`);
  }

  // 3) Enable HTTPS on tailnet settings when needed.
  if (hasHttpsUpdate) {
    const patchRes = await apiRequestJson({
      method: "PATCH",
      endpointPath: `/tailnet/${encodedTailnet}/settings`,
      accessToken,
      body: { httpsEnabled: true },
    });

    if (patchRes.status !== 200) {
      console.error(`\n❌  Failed to enable Tailnet HTTPS (HTTP ${patchRes.status}).`);
      if (patchRes.body && patchRes.body.message) {
        console.error(`    ${patchRes.body.message}`);
      }
      console.error("    Changes applied before this step were kept.\n");
      process.exit(1);
    }
    console.log("✅  Tailnet HTTPS enabled.");
  }

  // 4) Render tailscale serve config from env-derived values.
  if (hasServeFileUpdate) {
    fs.mkdirSync(path.dirname(servePathResolved), { recursive: true });
    fs.writeFileSync(servePathResolved, serveFileExpectedText, "utf-8");
    console.log(`✅  Serve config ${serveFileExists ? "updated" : "created"}: ${serveFilePathRaw}`);
  }

  // 5) Update env last.
  if (hasEnvFileUpdate) {
    envUpdates.forEach((u) => {
      upsertEnvLine(envLines, envMap, u.key, u.after);
    });
    let updatedEnv = envLines.join(envEol);
    if (envHadTrailingNewline && !updatedEnv.endsWith(envEol)) {
      updatedEnv += envEol;
    }
    fs.writeFileSync(envPath, updatedEnv, "utf-8");
    console.log(`✅  Updated ${envPathArg}`);
  } else if (hasEnvUpdate) {
    envUpdates.forEach((u) => {
      console.log(`ℹ️   Inferred ${u.key}=${u.after} (not persisted; pass .env path to write file).`);
    });
  }

  console.log("\nDone.\n");
}

main().catch((err) => {
  console.error(`❌  Unexpected error: ${err.message}`);
  process.exit(1);
});
