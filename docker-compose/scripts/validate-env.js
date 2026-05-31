#!/usr/bin/env node
"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");

const envPath = path.resolve(process.cwd(), ".env");
if (!fs.existsSync(envPath)) {
  console.error("❌ .env file not found. Hãy tạo từ .env.example trước khi deploy.");
  process.exit(1);
}

function parseEnvFile(filePath) {
  const out = {};
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const idx = s.indexOf("=");
    const key = s.slice(0, idx).trim();
    let value = s.slice(idx + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    out[key] = value;
  }
  return out;
}

const env = parseEnvFile(envPath);

function expandEnvReferences(values) {
  const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  for (let pass = 0; pass < 5; pass += 1) {
    let changed = false;
    for (const [key, value] of Object.entries(values)) {
      const next = String(value || "").replace(pattern, (_match, name) => values[name] ?? "");
      if (next !== value) {
        values[key] = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
}

expandEnvReferences(env);

const errors = [];
const warnings = [];
const ok = [];

function isBool(v) {
  return v === "true" || v === "false";
}

function checkPort(key, required = true) {
  const v = env[key];
  if (!v) {
    if (required) errors.push(`${key} is required`);
    else warnings.push(`${key} not set (optional)`);
    return;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    errors.push(`${key} must be an integer in range 1..65535`);
    return;
  }
  ok.push(`${key}=${n}`);
}

function checkRequired(key, desc, validate) {
  const v = (env[key] || "").trim();
  if (!v) {
    errors.push(`${key} is required (${desc})`);
    return;
  }
  if (validate) {
    const msg = validate(v);
    if (msg) {
      errors.push(`${key}: ${msg}`);
      return;
    }
  }
  ok.push(`${key}=OK`);
}

function checkOptional(key, desc, validate) {
  const v = (env[key] || "").trim();
  if (!v) {
    warnings.push(`${key} optional: ${desc}`);
    return;
  }
  if (validate) {
    const msg = validate(v);
    if (msg) {
      errors.push(`${key}: ${msg}`);
      return;
    }
  }
  ok.push(`${key}=OK (optional)`);
}

function isValidDomain(v) {
  if (v.startsWith("http://") || v.startsWith("https://")) return "must not include http/https";
  if (v.endsWith("/")) return "must not end with /";
  if (!v.includes(".")) return "must be a valid domain, e.g. example.com";
  return null;
}

function isValidHttpsJsonUrl(v) {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.pathname.endsWith(".json");
  } catch {
    return false;
  }
}

function isValidHttpsOrigin(v) {
  try {
    const u = new URL(v);
    if (u.protocol !== "https:") return "must start with https://";
    if (u.pathname !== "/" || u.search || u.hash) {
      return "must be an origin URL only, e.g. https://auth.example.com";
    }
    if (v.endsWith("/")) return "must not end with /";
    return null;
  } catch {
    return "must be a valid https URL";
  }
}

function normalizeDockerEscapedDollar(v) {
  return String(v || "").replace(/\$\$/g, "$");
}

function decodeRcloneConfigBase64(v) {
  const cleaned = String(v || "").replace(/\s/g, "");
  if (!cleaned || cleaned.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    return { error: "must be valid base64" };
  }
  try {
    const config = Buffer.from(cleaned, "base64").toString("utf8");
    const remotes = [...config.matchAll(/^\s*\[([^\]\r\n]+)\]\s*$/gm)].map((match) => match[1].trim());
    if (!remotes.length) return { error: "decoded config must contain at least one [remote] section" };
    return { config, remotes };
  } catch {
    return { error: "must be valid base64" };
  }
}

function parseRcloneRemoteTarget(v) {
  const idx = String(v || "").indexOf(":");
  if (idx <= 0) return { error: "must use <remote_name>:<bucket_or_path> format" };
  return { remote: v.slice(0, idx) };
}

const TINYAUTH_EXAMPLE_BCRYPT_HASH = "$2a$10$UdLYoJ5lgPsC0RKqYH/jMua7zIn0g9kPqWmhYayJYLaZQ/FTmH2/u";

function validateTinyauthUsers(v) {
  if (/(^|[^$])\$(?!\$)/.test(v)) {
    return "bcrypt dollars must be escaped as $$ for Docker Compose";
  }
  const users = v
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!users.length) return "must contain at least one user";

  for (const entry of users) {
    const parts = entry.split(":");
    const username = (parts[0] || "").trim();
    const hash = normalizeDockerEscapedDollar(parts[1] || "");
    if (!username || parts.length < 2) {
      return "each entry must use username:bcrypt_hash[:totp]";
    }
    if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) {
      return "password must be a bcrypt hash, not a plain password";
    }
    if (hash === TINYAUTH_EXAMPLE_BCRYPT_HASH) {
      return "uses the bundled example bcrypt hash; generate a deployment-specific hash";
    }
  }

  return null;
}

function validateTrustedProxies(v) {
  const entries = v
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!entries.length) return "must contain at least one IP/CIDR";

  for (const entry of entries) {
    const [ip, prefix, extra] = entry.split("/");
    if (extra !== undefined || !net.isIP(ip)) {
      return `invalid IP/CIDR entry: ${entry}`;
    }
    if (prefix !== undefined) {
      const n = Number(prefix);
      const max = net.isIP(ip) === 4 ? 32 : 128;
      if (!Number.isInteger(n) || n < 0 || n > max) {
        return `invalid CIDR prefix in entry: ${entry}`;
      }
    }
  }

  return null;
}

function buildAppHost(project, domain) {
  const p = (project || "").trim().toLowerCase();
  const d = (domain || "").trim().toLowerCase();
  if (p && d && (d === p || d.startsWith(`${p}.`))) {
    return domain;
  }
  return `${project}.${domain}`;
}

// ── 9router multi-version ───────────────────────────────────────────

function discoverNineRouterKeys() {
  const declared = String(env.NINE_ROUTER_VERSIONS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const auto = Object.keys(env)
    .map((k) => k.match(/^NINE_ROUTER_ENABLE_([A-Z0-9_]+)$/))
    .filter(Boolean)
    .map((m) => m[1])
    .filter((key) => (env[`NINE_ROUTER_ENABLE_${key}`] || "").trim() === "true");
  return Array.from(new Set([...declared, ...auto]));
}

function validateNineRouter() {
  const keys = discoverNineRouterKeys();
  const enabledKeys = keys.filter((k) => (env[`NINE_ROUTER_ENABLE_${k}`] || "").trim() === "true");

  if (!enabledKeys.length) {
    errors.push(
      "Stack ninerouter cần ít nhất 1 version được enable. Đặt NINE_ROUTER_ENABLE_<KEY>=true (ví dụ NINE_ROUTER_ENABLE_LATEST=true).",
    );
    return;
  }

  // Shared required (no per-version override needed for these)
  checkRequired("NINE_ROUTER_JWT_SECRET", "9router JWT secret (REQUIRED bởi app)", (v) =>
    v.length >= 16 ? null : "phải >= 16 ký tự (sinh: openssl rand -hex 64)",
  );
  checkRequired("NINE_ROUTER_INITIAL_PASSWORD", "9router initial admin password");
  checkRequired("NINE_ROUTER_DATA_DIR", "DATA_DIR bên trong container", (v) =>
    v.startsWith("/") ? null : "phải là absolute path bắt đầu bằng /",
  );
  checkRequired("NINE_ROUTER_PORT", "Port 9router lắng nghe trong container", (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? null : "phải là integer 1..65535";
  });
  // Cảnh báo nếu để default secrets
  if ((env.NINE_ROUTER_JWT_SECRET || "").trim() === "change-me-to-a-long-random-secret") {
    warnings.push("NINE_ROUTER_JWT_SECRET vẫn là giá trị mẫu — đổi trước khi deploy production.");
  }
  if ((env.NINE_ROUTER_INITIAL_PASSWORD || "").trim() === "change-me") {
    warnings.push("NINE_ROUTER_INITIAL_PASSWORD vẫn là giá trị mẫu — đổi trước khi deploy production.");
  }

  const usedHostPorts = new Map();
  const usedSlugs = new Map();

  for (const key of enabledKeys) {
    const ctx = `NINE_ROUTER[${key}]`;
    const enableVar = `NINE_ROUTER_ENABLE_${key}`;
    const enableVal = (env[enableVar] || "").trim();
    if (!isBool(enableVal)) {
      errors.push(`${enableVar} phải là true|false (đang: "${enableVal}")`);
      continue;
    }

    // IMAGE_TAG
    const imageVar = `NINE_ROUTER_IMAGE_TAG_${key}`;
    const imageTag = (env[imageVar] || "").trim();
    if (!imageTag) {
      // LATEST có default trong render script; các key khác bắt buộc.
      if (key !== "LATEST") {
        errors.push(`${imageVar} bắt buộc cho version "${key}" (ví dụ: 0.4.46)`);
      } else {
        warnings.push(`${imageVar} trống — render script sẽ dùng default "latest".`);
      }
    } else if (!/^[A-Za-z0-9._:-]+$/.test(imageTag)) {
      errors.push(`${imageVar} chứa ký tự không hợp lệ cho Docker tag: "${imageTag}"`);
    }

    // SUBDOMAIN
    const slugVar = `NINE_ROUTER_SUBDOMAIN_${key}`;
    let slug = (env[slugVar] || "").trim();
    if (!slug) {
      slug = key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      warnings.push(`${slugVar} trống — sẽ dùng slug auto-derived "${slug}".`);
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      errors.push(
        `${slugVar} không hợp lệ "${slug}" — chỉ được dùng [a-z0-9-] và bắt đầu bằng [a-z0-9].`,
      );
    } else if (usedSlugs.has(slug)) {
      errors.push(`${slugVar}="${slug}" trùng với version ${usedSlugs.get(slug)}.`);
    } else {
      usedSlugs.set(slug, key);
    }

    // HOST_PORT
    const portVar = `NINE_ROUTER_HOST_PORT_${key}`;
    const portRaw = (env[portVar] || "").trim();
    if (!portRaw) {
      warnings.push(`${portVar} trống — render script sẽ tự cấp port (>= 20128).`);
    } else {
      const n = Number(portRaw);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        errors.push(`${portVar} phải là integer 1..65535 (đang: "${portRaw}")`);
      } else if (usedHostPorts.has(n)) {
        errors.push(
          `${portVar}=${n} trùng với version ${usedHostPorts.get(n)} — mỗi version cần host port khác nhau.`,
        );
      } else {
        usedHostPorts.set(n, key);
      }
    }

    ok.push(`${ctx} subdomain=${slug}.${env.DOMAIN || "<DOMAIN>"} image=${imageTag || "latest"} hostPort=${portRaw || "auto"}`);
  }
}

// 1) Required core env from compose files
checkRequired("PROJECT_NAME", "docker project/network + subdomain prefix", (v) =>
  /^[a-z0-9][a-z0-9-]*$/.test(v) ? null : "only lowercase letters, numbers, hyphen",
);
checkRequired("DOMAIN", "root domain", isValidDomain);
checkRequired("CADDY_EMAIL", "caddy email label", (v) => (v.includes("@") ? null : "invalid email"));
checkRequired("TINYAUTH_APP_URL", "public HTTPS Tinyauth URL", isValidHttpsOrigin);
checkPort("TINYAUTH_PORT", true);
checkRequired("TINYAUTH_DB_FILE", "Tinyauth SQLite file", (v) => (v.includes("/") || v.includes("\\") ? "must be a filename, not a path" : null));
// checkRequired("TINYAUTH_USERS", "static users in username:bcrypt_hash format", validateTinyauthUsers);
checkRequired("TINYAUTH_COOKIE_SECURE", "secure cookie toggle", (v) => (isBool(v) ? null : "must be true|false"));
checkRequired("TINYAUTH_TRUSTED_PROXIES", "trusted Caddy/Cloudflared/Tailscale proxy CIDRs", validateTrustedProxies);
checkOptional("TINYAUTH_OAUTH_AUTO_REDIRECT", "none|github|google|generic", (v) =>
  v === "none" || /^[a-z][a-z0-9_-]*$/.test(v) ? null : "must be none or a provider id",
);
checkOptional("TINYAUTH_OAUTH_WHITELIST", "comma-separated OAuth email/domain/regex whitelist");
for (const [name, clientKey, secretKey] of [
  ["Google", "TINYAUTH_GOOGLE_CLIENT_ID", "TINYAUTH_GOOGLE_CLIENT_SECRET"],
  ["GitHub", "TINYAUTH_GITHUB_CLIENT_ID", "TINYAUTH_GITHUB_CLIENT_SECRET"],
  ["Generic", "TINYAUTH_GENERIC_CLIENT_ID", "TINYAUTH_GENERIC_CLIENT_SECRET"],
]) {
  const clientId = (env[clientKey] || "").trim();
  const clientSecret = (env[secretKey] || "").trim();
  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) errors.push(`${name} OAuth requires both ${clientKey} and ${secretKey}`);
    else ok.push(`${name} OAuth client/secret=OK (optional)`);
  }
}
for (const key of [
  "TINYAUTH_SECRET",
  "TINYAUTH_DISABLE_CONTINUE",
  "TINYAUTH_TRUST_PROXY",
  "TINYAUTH_ALLOWED_USERS",
  "TINYAUTH_ALLOWED_DOMAINS",
  "TINYAUTH_ALLOWED_GROUPS",
  "TINYAUTH_OIDC_ISSUER",
  "TINYAUTH_OIDC_CLIENT_ID",
  "TINYAUTH_OIDC_CLIENT_SECRET",
  "TINYAUTH_OIDC_SCOPES",
]) {
  if ((env[key] || "").trim()) {
    warnings.push(`${key} is legacy/deprecated for Tinyauth v5 and is not passed to the tinyauth container`);
  }
}
checkPort("APP_PORT", false); // legacy (template default app); ignored if 9router-only stack

// 9router multi-version — validate per-version config block (NINE_ROUTER_*)
validateNineRouter();

// 2) Optional env from compose files
checkPort("APP_HOST_PORT", false); // legacy (template default app)
checkPort("DOZZLE_HOST_PORT", false);
checkPort("FILEBROWSER_HOST_PORT", false);
checkPort("WEBSSH_HOST_PORT", false);
checkOptional("NODE_ENV", "app runtime env (legacy)");
checkOptional("HEALTH_PATH", "health endpoint path (legacy — 9router uses /api/health)", (v) => (v.startsWith("/") ? null : "must start with '/'"));
checkOptional("DOCKER_SOCK", "docker socket path override");
checkPort("DOCKER_DEPLOY_CODE_PORT", false);
checkPort("DOCKER_DEPLOY_CODE_HOST_PORT", false);
checkOptional("DOCKER_DEPLOY_CODE_CADDY_HOSTS", "public Caddy host for deploy-code UI/API");
checkOptional("DOCKER_DEPLOY_CODE_REPO_DIR", "repo path mounted inside deploy-code sidecar");
checkOptional("DOCKER_DEPLOY_CODE_BRANCH", "git branch to deploy");
checkOptional("DOCKER_DEPLOY_CODE_REMOTE", "git remote to fetch");
checkOptional("DOCKER_DEPLOY_CODE_COMPOSE_SCRIPT", "compose orchestration script inside repo");
checkOptional("DOCKER_DEPLOY_CODE_DEPLOY_SERVICES", "comma-separated compose services to rebuild/redeploy");
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_CONTROL_ENABLED", "true|false toggle for container control API", (v) =>
  isBool(v) ? null : "must be true|false",
);
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_ALLOW_ALL", "true|false toggle to allow all Docker containers", (v) =>
  isBool(v) ? null : "must be true|false",
);
checkOptional("DOCKER_DEPLOY_CODE_SERVICE_ALLOWLIST", "comma-separated compose services allowed for start/stop/restart/rebuild/logs");
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_ALLOWLIST", "comma-separated containers allowed for start/stop/restart/logs/inspect");
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_LOG_DEFAULT_LINES", "default container log tail lines", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? null : "must be positive integer";
});
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_LOG_MAX_LINES", "max container log tail lines", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? null : "must be positive integer";
});
checkOptional("DOCKER_DEPLOY_CODE_CONTAINER_ACTION_TIMEOUT_SEC", "Docker action timeout seconds", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 30 ? null : "must be integer >= 30";
});
checkOptional("DOCKER_DEPLOY_CODE_POLL_INTERVAL_SEC", "git polling interval seconds", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 30 ? null : "must be integer >= 30";
});
checkOptional("DOCKER_DEPLOY_CODE_ZIP_MAX_MB", "max raw ZIP upload size in MB", (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? null : "must be positive integer";
});

if (env.DOCKER_DEPLOY_CODE_ENABLED === "true") {
  checkRequired("DOCKER_DEPLOY_CODE_DEPLOY_SERVICES", "service(s) deploy-code may rebuild/redeploy");
  checkRequired("DOCKER_DEPLOY_CODE_CADDY_HOSTS", "public deploy-code hostname for Caddy");

  const requireToken = (env.DOCKER_DEPLOY_CODE_REQUIRE_TOKEN || "true").trim();
  if (!isBool(requireToken)) {
    errors.push("DOCKER_DEPLOY_CODE_REQUIRE_TOKEN must be true|false");
  } else if (requireToken === "true") {
    checkRequired("DOCKER_DEPLOY_CODE_API_TOKEN", "required when deploy-code token auth is enabled", (v) =>
      v.length >= 16 ? null : "must be at least 16 characters",
    );
  } else {
    warnings.push("DOCKER_DEPLOY_CODE_REQUIRE_TOKEN=false while deploy-code is enabled -> rely on Tinyauth / private network only");
  }
}

// 3) Flags
for (const key of [
  "ENABLE_DOZZLE",
  "ENABLE_FILEBROWSER",
  "ENABLE_WEBSSH",
  "ENABLE_TAILSCALE",
  "ENABLE_LITESTREAM",
  "ENABLE_RCLONE",
  "DOCKER_DEPLOY_CODE_ENABLED",
  "DOCKER_DEPLOY_CODE_POLL_ENABLED",
  "DOCKER_DEPLOY_CODE_AUTO_DEPLOY_ON_CHANGE",
  "DOCKER_DEPLOY_CODE_RUN_ON_START",
  "DOCKER_DEPLOY_CODE_REQUIRE_TOKEN",
  "DOCKER_DEPLOY_CODE_GIT_CLEAN",
  "DOCKER_DEPLOY_CODE_ZIP_STRIP_TOP_LEVEL",
  "DOCKER_DEPLOY_CODE_ZIP_DELETE_MISSING",
  "DOCKER_DEPLOY_CODE_ZIP_BACKUP_BEFORE_APPLY",
  "DOCKER_DEPLOY_CODE_ZIP_DEPLOY_AFTER_APPLY",
]) {
  const v = env[key];
  if (!v) {
    warnings.push(`${key} not set -> using default from scripts/compose`);
    continue;
  }
  if (!isBool(v)) errors.push(`${key} must be true|false`);
  else ok.push(`${key}=${v}`);
}

if ((env.ENABLE_RCLONE || "false") === "true") {
  checkRequired("RCLONE_CONFIG_BASE64", "base64-encoded rclone.conf", (v) => decodeRcloneConfigBase64(v).error || null);
  checkRequired("RCLONE_REMOTE_TARGET", "<remote_name>:<bucket_or_path>", (v) => parseRcloneRemoteTarget(v).error || null);

  const config = decodeRcloneConfigBase64(env.RCLONE_CONFIG_BASE64);
  const target = parseRcloneRemoteTarget(env.RCLONE_REMOTE_TARGET);
  if (!config.error && !target.error) {
    if (!config.remotes.includes(target.remote)) {
      errors.push(`RCLONE_REMOTE_TARGET remote "${target.remote}" not found in decoded rclone.conf sections: ${config.remotes.join(", ")}`);
    } else {
      ok.push(`RCLONE_REMOTE_TARGET remote=${target.remote}`);
    }
  }
}

if ((env.ENABLE_LITESTREAM || "true") === "true") {
  const initMode = (env.LITESTREAM_INIT_MODE || "").trim();
  if (!isBool(initMode)) errors.push("LITESTREAM_INIT_MODE must be true|false");
  checkRequired("LITESTREAM_REPLICATE_DBS", "comma-separated SQLite DB ids (this stack only replicates `tinyauth`; 9router data is backed up via rclone)");
  // Warn if LITESTREAM_REPLICATE_DBS still includes legacy `app` token — no longer supported in this stack.
  {
    const dbs = String(env.LITESTREAM_REPLICATE_DBS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (dbs.includes("app")) {
      warnings.push(
        "LITESTREAM_REPLICATE_DBS contains `app` — this stack no longer replicates app via Litestream. Remove `app` (keep only `tinyauth`); 9router data is backed up via rclone.",
      );
    }
  }
  checkRequired("LITESTREAM_S3_ENDPOINT", "S3-compatible endpoint", (v) =>
    v.startsWith("http://") || v.startsWith("https://") ? null : "must start with http:// or https://",
  );
  checkRequired("LITESTREAM_S3_BUCKET", "S3 bucket");
  checkRequired("LITESTREAM_S3_ACCESS_KEY_ID", "S3 access key id");
  checkRequired("LITESTREAM_S3_SECRET_ACCESS_KEY", "S3 secret access key");
  checkRequired("LITESTREAM_TINYAUTH_S3_PATH", "Tinyauth replica path");
  // Note: LITESTREAM_APP_* removed — the 9router stack does not use Litestream for application data.
  // 9router per-version SQLite under ${DOCKER_VOLUMES_ROOT}/ninerouter/<slug>/data/ is backed up via rclone (see compose.rclone.yml).
  checkRequired("LITESTREAM_SYNC_INTERVAL", "Litestream sync interval");
  checkRequired("LITESTREAM_SNAPSHOT_INTERVAL", "Litestream snapshot interval");
  checkRequired("LITESTREAM_RETENTION", "Litestream retention");
  checkRequired("LITESTREAM_RETENTION_CHECK_INTERVAL", "Litestream retention check interval");
}

// 4) Files required by cloudflared mounts
const cfConfig = path.resolve(process.cwd(), "cloudflared/config.yml");
const cfCreds = path.resolve(process.cwd(), "cloudflared/credentials.json");
if (!fs.existsSync(cfConfig)) errors.push("cloudflared/config.yml missing (cloudflared mount required)");
else ok.push("cloudflared/config.yml present");
if (!fs.existsSync(cfCreds)) errors.push("cloudflared/credentials.json missing (cloudflared mount required)");
else ok.push("cloudflared/credentials.json present");

// 5) Optional webssh runtime tuning vars
if ((env.ENABLE_WEBSSH || "true") === "true") {
  if (!env.CUR_WHOAMI) warnings.push("CUR_WHOAMI optional (webssh linux default runner)");
  if (!env.CUR_WORK_DIR) warnings.push("CUR_WORK_DIR optional (webssh linux default /home/runner)");
  if (!env.SHELL) warnings.push("SHELL optional (webssh linux default /bin/bash)");
}

// 6) Tailscale + keep-ip rules based on compose.access.yml
if (env.ENABLE_TAILSCALE === "true") {
  checkRequired("TAILSCALE_AUTHKEY", "required by tailscale service", (v) => (v.startsWith("tskey-") ? null : "must start with tskey-"));
  checkRequired("TAILSCALE_TAILNET_DOMAIN", "required by dc.sh to render tailscale/serve.json", (v) =>
    v && v !== "-" ? null : "must not be empty or '-'",
  );
  checkOptional("TAILSCALE_TAGS", "advertise tags", (v) =>
    /^tag:[A-Za-z0-9][A-Za-z0-9_-]*(,tag:[A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(v) ? null : "format must be tag:a,tag:b",
  );

  const keepIp = (env.TAILSCALE_KEEP_IP_ENABLE || "false").trim();
  if (!isBool(keepIp)) errors.push("TAILSCALE_KEEP_IP_ENABLE must be true|false");

  const keepRemove = (env.TAILSCALE_KEEP_IP_REMOVE_HOSTNAME_ENABLE || "").trim();
  if (keepRemove && !isBool(keepRemove)) {
    errors.push("TAILSCALE_KEEP_IP_REMOVE_HOSTNAME_ENABLE must be true|false when provided");
  }

  if (keepIp === "true") {
    checkRequired("TAILSCALE_KEEP_IP_FIREBASE_URL", "required when keep-ip enabled", (v) =>
      isValidHttpsJsonUrl(v) ? null : "must be https URL ending with .json",
    );
    checkOptional("TAILSCALE_KEEP_IP_CERTS_DIR", "certs dir path");
    checkOptional("TAILSCALE_KEEP_IP_INTERVAL_SEC", "backup interval seconds", (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 5 ? null : "must be integer >= 5";
    });
  } else {
    warnings.push("TAILSCALE_KEEP_IP_ENABLE=false -> keep-ip backup/restore disabled");
  }

  const removeHostnameEnabled = keepRemove ? keepRemove === "true" : keepIp === "true";
  if (removeHostnameEnabled) {
    if (!env.TAILSCALE_CLIENTID) {
      errors.push("remove-hostname enabled requires TAILSCALE_CLIENTID");
    }
    const authKey = (env.TAILSCALE_AUTHKEY || "").trim();
    if (!authKey) {
      errors.push("remove-hostname enabled requires TAILSCALE_AUTHKEY");
    } else if (!authKey.startsWith("tskey-client-")) {
      errors.push("remove-hostname requires TAILSCALE_AUTHKEY in tskey-client-* format");
    }
  }
}

const project = env.PROJECT_NAME || "<project>";
const domain = env.DOMAIN || "<domain>";
const host = env.PROJECT_NAME || "myapp";
const tailnet = env.TAILSCALE_TAILNET_DOMAIN || "tailnet.local";
const appHost = buildAppHost(project, domain);

// Subdomain preview: 9router per-version
{
  const keys = discoverNineRouterKeys();
  const enabledKeys = keys.filter((k) => String(env[`NINE_ROUTER_ENABLE_${k}`] || "false").toLowerCase() === "true");
  if (enabledKeys.length === 0) {
    warnings.push("subdomain preview: no enabled 9router version (NINE_ROUTER_ENABLE_<KEY>=true)");
  } else {
    for (const key of enabledKeys) {
      const slug = (env[`NINE_ROUTER_SUBDOMAIN_${key}`] || key.toLowerCase()).trim();
      ok.push(`subdomain preview: ninerouter-${slug}=${slug}.${domain}`);
    }
  }
}
if ((env.ENABLE_DOZZLE || "true") === "true") ok.push(`subdomain preview: logs=logs.${domain}`);
if ((env.ENABLE_FILEBROWSER || "true") === "true") ok.push(`subdomain preview: files=files.${domain}`);
if ((env.ENABLE_WEBSSH || "true") === "true") ok.push(`subdomain preview: ttyd=ttyd.${domain}`);
if (env.DOCKER_DEPLOY_CODE_ENABLED === "true") {
  ok.push(`subdomain preview: deploy-code=${env.DOCKER_DEPLOY_CODE_CADDY_HOSTS || `deploy.${domain}`}`);
}
if (env.ENABLE_TAILSCALE === "true") {
  const dozzlePort = env.DOZZLE_HOST_PORT || "18080";
  const filesPort = env.FILEBROWSER_HOST_PORT || "18081";
  const sshPort = env.WEBSSH_HOST_PORT || "17681";
  const deployCodePort = env.DOCKER_DEPLOY_CODE_HOST_PORT || "15399";
  ok.push(`tailnet host: https://${host}.${tailnet}`);
  if ((env.ENABLE_DOZZLE || "true") === "true") ok.push(`tailnet dozzle: http://${host}.${tailnet}:${dozzlePort}`);
  if ((env.ENABLE_FILEBROWSER || "true") === "true") ok.push(`tailnet filebrowser: http://${host}.${tailnet}:${filesPort}`);
  if ((env.ENABLE_WEBSSH || "true") === "true") ok.push(`tailnet webssh: http://${host}.${tailnet}:${sshPort}`);
  if (env.DOCKER_DEPLOY_CODE_ENABLED === "true") ok.push(`tailnet deploy-code: http://${host}.${tailnet}:${deployCodePort}`);
}

console.log("\n📋 ENV VALIDATION REPORT");
console.log("─".repeat(60));

if (ok.length) {
  console.log(`\n✅ Valid (${ok.length})`);
  for (const s of ok) console.log(`  - ${s}`);
}
if (warnings.length) {
  console.log(`\n⚠️ Warnings (${warnings.length})`);
  for (const s of warnings) console.log(`  - ${s}`);
}
if (errors.length) {
  console.log(`\n❌ Errors (${errors.length})`);
  for (const s of errors) console.log(`  - ${s}`);
  console.log("\nDừng triển khai. Hãy sửa lỗi bắt buộc trước khi chạy up.\n");
  process.exit(1);
}

console.log("\n✅ Env hợp lệ. Có thể triển khai.\n");
