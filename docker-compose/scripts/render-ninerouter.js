#!/usr/bin/env node
/**
 * render-ninerouter.js
 * ====================
 *
 * Generate `compose.ninerouter.yml` ở project root từ các biến môi
 * trường `NINE_ROUTER_*` trong `.env`.
 *
 * Cách hoạt động:
 *   1. Đọc `.env` (và expand ${VAR} reference).
 *   2. Parse `NINE_ROUTER_VERSIONS` (CSV của các KEY uppercase, ví dụ
 *      "LATEST,V0446"). Tự thêm KEY nếu user khai báo
 *      `NINE_ROUTER_ENABLE_<KEY>=true` mà quên đưa vào VERSIONS.
 *   3. Với mỗi KEY:
 *        - Bỏ qua nếu `NINE_ROUTER_ENABLE_<KEY>` không phải "true".
 *        - Đọc các biến per-version (xem PER_VERSION_FIELDS dưới);
 *          fallback sang biến shared `NINE_ROUTER_<FIELD>` rồi sang
 *          default cứng (xem DEFAULTS).
 *        - Render thành 1 service Docker tên `ninerouter-<slug>`.
 *   4. Ghi `compose.ninerouter.yml`.
 *
 * Quan trọng: file output là TEMPLATED YAML; tất cả `${VAR}` còn lại
 * sẽ được Docker Compose tự expand từ `.env`. Script chỉ inline các
 * giá trị mang tính cấu trúc (slug, host port, image build args,
 * subdomain) — không inline secrets.
 *
 * Auth:
 *   Theo yêu cầu task, mọi service 9router KHÔNG dùng Tinyauth
 *   forward_auth. Auth do app 9router xử lý nội bộ. Caddy chỉ
 *   reverse_proxy.
 *
 * Usage:
 *   node docker-compose/scripts/render-ninerouter.js
 *   node docker-compose/scripts/render-ninerouter.js --check   # exit 1 nếu output stale
 *
 * Được gọi tự động bởi dc.sh trước mỗi compose command.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const ENV_FILE = path.join(ROOT, ".env");
const OUTPUT_FILE = path.join(ROOT, "compose.ninerouter.yml");
const RCLONE_GATE_FILE = path.join(ROOT, "docker-compose", "compose.ninerouter-rclone-gate.yml");

// ── Helpers ─────────────────────────────────────────────────────────

function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const s = line.replace(/\r$/, "");
    const t = s.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const idx = t.indexOf("=");
    const key = t.slice(0, idx).trim();
    let value = t.slice(idx + 1).trim();
    // Strip một cặp quote bao ngoài (không xử lý escape phức tạp).
    if (value.length >= 2) {
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
    }
    // Compose-escape: $$ -> $ ở runtime.
    value = value.replace(/\$\$/g, "$");
    out[key] = value;
  }
  return out;
}

function expandRefs(env) {
  const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  for (let pass = 0; pass < 5; pass += 1) {
    let changed = false;
    for (const [k, v] of Object.entries(env)) {
      const next = String(v || "").replace(pattern, (_m, name) => env[name] ?? "");
      if (next !== v) {
        env[k] = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return env;
}

function isTrue(v) {
  return String(v || "").trim().toLowerCase() === "true";
}

function trim(v) {
  return String(v == null ? "" : v).trim();
}

function slugify(key) {
  // KEY uppercase (LATEST, V0446) -> slug lowercase dùng cho subdomain/path.
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "default";
}

// ── Defaults & per-version contract ────────────────────────────────

// Các biến shared chung cho mọi version. Per-version override bằng
// NINE_ROUTER_<FIELD>_<KEY>. Mỗi entry: [field, default].
const SHARED_DEFAULTS = {
  PORT: "20128",
  NODE_ENV: "production",
  DATA_DIR: "/app/data",
  JWT_SECRET: "change-me-to-a-long-random-secret",
  INITIAL_PASSWORD: "change-me",
  API_KEY_SECRET: "endpoint-proxy-api-key-secret",
  MACHINE_ID_SALT: "endpoint-proxy-salt",
  ENABLE_REQUEST_LOGS: "false",
  OBSERVABILITY_ENABLED: "true",
  AUTH_COOKIE_SECURE: "false",
  REQUIRE_API_KEY: "false",
  CLOUD_URL: "https://9router.com",
  // BASE_URL/NEXT_PUBLIC_BASE_URL được render per-version (theo subdomain).
};

// Các field nhận giá trị riêng theo version (image, subdomain, host port…).
// Không có giá trị nào trong nhóm này có shared fallback.
const PER_VERSION_REQUIRED = {
  IMAGE_TAG: { defaultByKey: { LATEST: "latest" } }, // mặc định LATEST -> "latest", còn lại không có default
  SUBDOMAIN: { deriveFromSlug: true },
  HOST_PORT: { autoIncrementBase: 20128 }, // nếu không khai báo, tự cấp port
};

// Các field 9router-specific (hỗ trợ override per-version, nếu không
// thì lấy shared, nếu không thì lấy default trong SHARED_DEFAULTS).
const APP_FIELDS = Object.keys(SHARED_DEFAULTS);

// Outbound proxy (optional, không có default, không output env nếu trống).
const OPTIONAL_PROXY_FIELDS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];

// ── Resolve per-version config ─────────────────────────────────────

function resolveAppValue(env, field, key) {
  const perVersion = env[`NINE_ROUTER_${field}_${key}`];
  if (perVersion != null && perVersion !== "") return perVersion;
  const shared = env[`NINE_ROUTER_${field}`];
  if (shared != null && shared !== "") return shared;
  return SHARED_DEFAULTS[field];
}

function resolveProxy(env, field, key) {
  const perVersion = env[`NINE_ROUTER_${field}_${key}`];
  if (perVersion != null && perVersion !== "") return perVersion;
  const shared = env[`NINE_ROUTER_${field}`];
  if (shared != null && shared !== "") return shared;
  return "";
}

function resolveVersions(env) {
  const declared = trim(env.NINE_ROUTER_VERSIONS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Tự auto-discover thêm KEY nào có ENABLE_<KEY>=true mà chưa nằm trong list.
  const discovered = Object.keys(env)
    .map((k) => k.match(/^NINE_ROUTER_ENABLE_([A-Z0-9_]+)$/))
    .filter(Boolean)
    .map((m) => m[1])
    .filter((key) => isTrue(env[`NINE_ROUTER_ENABLE_${key}`]));

  const set = new Set([...declared, ...discovered]);
  return Array.from(set);
}

function buildVersions(env) {
  const keys = resolveVersions(env);
  const versions = [];
  let portCounter = 0;

  for (const key of keys) {
    if (!isTrue(env[`NINE_ROUTER_ENABLE_${key}`])) continue;

    const slug = trim(env[`NINE_ROUTER_SUBDOMAIN_${key}`]) || slugify(key);

    let imageTag = trim(env[`NINE_ROUTER_IMAGE_TAG_${key}`]);
    if (!imageTag) imageTag = PER_VERSION_REQUIRED.IMAGE_TAG.defaultByKey[key] || "";
    if (!imageTag) {
      throw new Error(
        `NINE_ROUTER_IMAGE_TAG_${key} bắt buộc cho version "${key}" (ví dụ: 0.4.46)`,
      );
    }

    let hostPort = trim(env[`NINE_ROUTER_HOST_PORT_${key}`]);
    if (!hostPort) {
      hostPort = String(PER_VERSION_REQUIRED.HOST_PORT.autoIncrementBase + portCounter);
      portCounter += 1;
    }

    const containerPort = resolveAppValue(env, "PORT", key);

    // ENV cho container — gom vào object để render YAML deterministic.
    const appEnv = {};
    for (const field of APP_FIELDS) {
      appEnv[field === "NODE_ENV" ? "NODE_ENV" : field] = resolveAppValue(env, field, key);
    }
    // Đảm bảo PORT khớp.
    appEnv.PORT = containerPort;
    appEnv.HOSTNAME = "0.0.0.0";

    // Subdomain-based BASE_URL (override shared nếu có).
    const baseUrl = trim(env[`NINE_ROUTER_BASE_URL_${key}`]);
    if (baseUrl) {
      appEnv.BASE_URL = baseUrl;
      appEnv.NEXT_PUBLIC_BASE_URL = baseUrl;
    } else {
      appEnv.BASE_URL = `https://${slug}.\${DOMAIN}`;
      appEnv.NEXT_PUBLIC_BASE_URL = `https://${slug}.\${DOMAIN}`;
    }

    // Outbound proxy: chỉ output nếu có giá trị.
    for (const field of OPTIONAL_PROXY_FIELDS) {
      const v = resolveProxy(env, field, key);
      if (v) appEnv[field] = v;
    }

    versions.push({
      key,
      slug,
      imageTag,
      hostPort,
      containerPort,
      env: appEnv,
    });
  }

  return versions;
}

// ── YAML rendering ─────────────────────────────────────────────────

function renderEnvBlock(envObj, indent) {
  const pad = " ".repeat(indent);
  const lines = [];
  for (const [k, v] of Object.entries(envObj)) {
    // Quote tất cả value để an toàn ký tự đặc biệt; escape " trong giá trị.
    const safe = String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    lines.push(`${pad}${k}: "${safe}"`);
  }
  return lines.join("\n");
}

function renderService(v) {
  const { key, slug, imageTag, hostPort, containerPort, env } = v;

  const imageRef = `\${PROJECT_NAME:-dockerstack-ninerouter}-9router:${slug}`;
  const dataVolume = `\${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/ninerouter/${slug}/data:/app/data`;
  // TLS internal cho Tailscale: vẫn dùng pattern caddy_1 nhưng KHÔNG forward_auth.
  // Subdomain pattern: ${slug}.${DOMAIN}
  const lines = [];
  lines.push(`  ninerouter-${slug}:`);
  lines.push(`    container_name: "main-ninerouter-${slug}"`);
  lines.push(`    image: "${imageRef}"`);
  lines.push(`    build:`);
  lines.push(`      context: ./services/9router`);
  lines.push(`      dockerfile: Dockerfile`);
  lines.push(`      args:`);
  lines.push(`        NINE_ROUTER_VERSION_TAG: "${imageTag}"`);
  lines.push(`    env_file:`);
  lines.push(`      - ./.env`);
  lines.push(`    environment:`);
  lines.push(renderEnvBlock(env, 6));
  lines.push(`    ports:`);
  lines.push(`      - "127.0.0.1:${hostPort}:${containerPort}"`);
  lines.push(`    volumes:`);
  lines.push(`      - ${dataVolume}`);
  lines.push(`    labels:`);
  // Public HTTP via Cloudflare Tunnel: <slug>.${DOMAIN}
  lines.push(`      - "caddy=http://${slug}.\${DOMAIN}, http://${slug}.\${PROJECT_NAME_TAILSCALE}.\${TAILSCALE_TAILNET_DOMAIN}"`);
  lines.push(`      - "caddy.reverse_proxy={{upstreams ${containerPort}}}"`);
  // SSE-friendly: 9router có /api/sync/cloud + observability streams.
  lines.push(`      - "caddy.reverse_proxy.flush_interval=-1"`);
  // Internal HTTPS qua Tailscale.
  lines.push(`      - "caddy_1=https://${slug}.\${PROJECT_NAME_TAILSCALE:-dockerstack-ninerouter}.\${TAILSCALE_TAILNET_DOMAIN:-tailnet.local}"`);
  lines.push(`      - "caddy_1.tls=internal"`);
  lines.push(`      - "caddy_1.reverse_proxy={{upstreams ${containerPort}}}"`);
  lines.push(`      - "caddy_1.reverse_proxy.flush_interval=-1"`);
  lines.push(`    networks: [app_net]`);
  lines.push(`    restart: unless-stopped`);
  lines.push(`    healthcheck:`);
  lines.push(`      test:`);
  lines.push(`        - "CMD"`);
  lines.push(`        - "sh"`);
  lines.push(`        - "-c"`);
  lines.push(`        - "wget -qO- http://localhost:${containerPort}/api/health || exit 1"`);
  lines.push(`      interval: 30s`);
  lines.push(`      timeout: 5s`);
  lines.push(`      retries: 3`);
  lines.push(`      start_period: 30s`);

  return lines.join("\n");
}

function renderRcloneGate(versions) {
  const header = `# ================================================================
#  compose.ninerouter-rclone-gate.yml — auto-generated
#
#  ⚠️  KHÔNG SỬA TAY. Render bởi:
#       node docker-compose/scripts/render-ninerouter.js
#
#  File này CHỈ được dc.sh nạp khi ENABLE_RCLONE=true.
#  Mỗi ninerouter-<slug> được thêm depends_on rclone-restore để đảm bảo
#  data đã được kéo về \${DOCKER_VOLUMES_ROOT} trước khi container start.
# ================================================================
`;
  if (!versions.length) {
    return `${header}\nservices: {}\n`;
  }
  const blocks = versions.map((v) => {
    return `  ninerouter-${v.slug}:\n    depends_on:\n      rclone-restore:\n        condition: service_completed_successfully`;
  });
  return `${header}\nservices:\n${blocks.join("\n\n")}\n`;
}

function renderCompose(versions) {
  const header = `# ================================================================
#  compose.ninerouter.yml — Application Layer (auto-generated)
#
#  ⚠️  KHÔNG SỬA TAY. File này được render bởi:
#       node docker-compose/scripts/render-ninerouter.js
#
#  Mỗi phiên bản 9router là 1 service riêng:
#    service name      : ninerouter-<slug>
#    container name    : main-ninerouter-<slug>
#    image             : decolua/9router:<NINE_ROUTER_IMAGE_TAG_<KEY>>
#    public subdomain  : <slug>.\${DOMAIN}
#    data volume       : \${DOCKER_VOLUMES_ROOT}/ninerouter/<slug>/data
#
#  Auth: 9router tự xử lý nội bộ (JWT). KHÔNG dùng Tinyauth forward_auth
#        cho service này.
#
#  Để thêm 1 phiên bản mới:
#    1. Vào .env, copy block ENV của 1 version có sẵn, đổi suffix KEY
#       (ví dụ V0459).
#    2. Set NINE_ROUTER_ENABLE_V0459=true,
#           NINE_ROUTER_IMAGE_TAG_V0459=0.4.59,
#           NINE_ROUTER_SUBDOMAIN_V0459=v0459,
#           NINE_ROUTER_HOST_PORT_V0459=<port>.
#    3. Thêm V0459 vào NINE_ROUTER_VERSIONS (hoặc bỏ qua bước này — script
#       tự auto-discover ENABLE_*=true).
#    4. Chạy: npm run dockerapp-exec:up
#       (dc.sh sẽ tự render lại file này trước khi gọi docker compose).
# ================================================================
`;

  if (!versions.length) {
    return `${header}
# Không có phiên bản 9router nào được enable.
# Bật ít nhất một version (ví dụ: NINE_ROUTER_ENABLE_LATEST=true).
services: {}
`;
  }

  const services = versions.map(renderService).join("\n\n");
  return `${header}
services:
${services}
`;
}

// ── Main ────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");

  const env = expandRefs(parseEnvFile(ENV_FILE));
  let versions;
  try {
    versions = buildVersions(env);
  } catch (e) {
    console.error(`❌ render-ninerouter: ${e.message}`);
    process.exit(1);
  }

  const yaml = renderCompose(versions);
  const gateYaml = renderRcloneGate(versions);

  if (checkOnly) {
    let stale = false;
    const current = fs.existsSync(OUTPUT_FILE) ? fs.readFileSync(OUTPUT_FILE, "utf8") : "";
    if (current !== yaml) stale = true;
    const currentGate = fs.existsSync(RCLONE_GATE_FILE) ? fs.readFileSync(RCLONE_GATE_FILE, "utf8") : "";
    if (currentGate !== gateYaml) stale = true;
    if (stale) {
      console.error(
        "❌ compose.ninerouter.yml hoặc compose.ninerouter-rclone-gate.yml không khớp với .env.\n" +
          "   Chạy: node docker-compose/scripts/render-ninerouter.js",
      );
      process.exit(1);
    }
    console.log("✓ compose.ninerouter.yml + rclone-gate synced với .env.");
    return;
  }

  fs.writeFileSync(OUTPUT_FILE, yaml, "utf8");
  fs.writeFileSync(RCLONE_GATE_FILE, gateYaml, "utf8");
  const slugs = versions.map((v) => `${v.slug}=${v.imageTag}@${v.hostPort}`).join(", ");
  console.log(
    `✓ compose.ninerouter.yml rendered (${versions.length} version${versions.length === 1 ? "" : "s"}: ${slugs || "<none>"})`,
  );
  console.log(`✓ compose.ninerouter-rclone-gate.yml rendered.`);
}

if (require.main === module) main();
module.exports = { parseEnvFile, expandRefs, buildVersions, renderCompose };
