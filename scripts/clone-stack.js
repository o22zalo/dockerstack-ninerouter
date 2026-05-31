#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

// ─── Argument parser ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--output" || a === "-o") out.output = argv[++i];
    else if (a.startsWith("--output=")) out.output = a.slice("--output=".length);
    else if (a === "--name" || a === "-n") out.name = argv[++i];
    else if (a.startsWith("--name=")) out.name = a.slice("--name=".length);
    else if (a === "--force" || a === "-f") out.force = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

// ─── Interactive prompt ──────────────────────────────────────────────────────

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    }),
  );
}

// ─── .cloneignore loader ─────────────────────────────────────────────────────

/**
 * Đọc file `.cloneignore` nằm cùng thư mục với clone-stack.js (tức scripts/).
 * Mỗi dòng là một pattern (tên file/thư mục hoặc glob đơn giản).
 * Dòng bắt đầu bằng `#` hoặc rỗng sẽ bị bỏ qua.
 *
 * Hỗ trợ:
 *   - Tên chính xác:   `.env`, `dist`, `coverage`
 *   - Wildcard đơn:    `*.log`, `*.local`, `tmp-*`
 *   - Glob sâu (**):   `**\/*.test.js`  (khớp bất kỳ cấp nào)
 */
function loadIgnorePatterns(sourceRepo) {
  // Các entry luôn bị bỏ qua, không cần khai báo trong .cloneignore
  const DEFAULT_ALWAYS_IGNORE = new Set([".git", "node_modules"]);

  // .cloneignore nằm cùng thư mục với file clone-stack.js (tức scripts/)
  const ignoreFilePath = path.join(__dirname, ".cloneignore");
  const patterns = [];

  if (fs.existsSync(ignoreFilePath)) {
    const lines = fs.readFileSync(ignoreFilePath, "utf8").split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      patterns.push(line);
    }
  }

  return { always: DEFAULT_ALWAYS_IGNORE, patterns };
}

/**
 * Chuyển glob pattern đơn giản thành RegExp.
 *   `**` → khớp bất kỳ đoạn đường dẫn (kể cả dấu /)
 *   `*`  → khớp bất kỳ ký tự trừ /
 *
 * Quy tắc anchor (giống gitignore):
 *   - Pattern CÓ chứa `/` (ví dụ: `scripts/**`, `cloudflared/config.yml`)
 *     → anchor về root: chỉ khớp từ đầu relPath
 *   - Pattern KHÔNG chứa `/` (ví dụ: `*.log`, `.env`)
 *     → khớp ở bất kỳ cấp nào trong cây thư mục
 */
function globToRegex(pattern) {
  const norm = pattern.replace(/\\/g, "/");

  // Xác định có cần anchor về root không
  // (pattern chứa / ở bất kỳ vị trí nào, trừ trailing slash)
  const stripped = norm.replace(/\/$/, "");
  const anchored = stripped.includes("/");

  let regStr = "";
  let i = 0;
  while (i < norm.length) {
    if (norm[i] === "*" && norm[i + 1] === "*") {
      regStr += ".*";
      i += 2;
      if (norm[i] === "/") i++; // bỏ / sau **
    } else if (norm[i] === "*") {
      regStr += "[^/]*";
      i++;
    } else if (".+^${}()|[]\\".includes(norm[i])) {
      regStr += "\\" + norm[i];
      i++;
    } else {
      regStr += norm[i];
      i++;
    }
  }

  if (anchored) {
    // Khớp chính xác từ đầu relPath (root-relative)
    return new RegExp("^" + regStr + "(/|$)");
  } else {
    // Khớp ở bất kỳ cấp nào
    return new RegExp("(^|/)" + regStr + "(/|$)");
  }
}

/**
 * Trả về true nếu `relPath` (đường dẫn tương đối từ source root, dùng /)
 * khớp với bất kỳ pattern nào trong danh sách ignore.
 */
function shouldIgnore(entryName, relPath, ignoreConfig) {
  if (ignoreConfig.always.has(entryName)) return true;

  const normRel = relPath.replace(/\\/g, "/");
  for (const pattern of ignoreConfig.patterns) {
    const rx = globToRegex(pattern);
    if (rx.test(normRel) || rx.test(entryName)) return true;
  }
  return false;
}

// ─── .env.cloneignore loader ─────────────────────────────────────────────────

/**
 * Đọc file `.env.cloneignore` nằm cùng thư mục với clone-stack.js.
 * Mỗi dòng là một tên biến môi trường cần xoá trắng value khi copy .env*.
 * Dòng bắt đầu bằng `#` hoặc rỗng bị bỏ qua.
 *
 * Ví dụ .env.cloneignore:
 *   DB_PASSWORD
 *   JWT_SECRET
 *   CLOUDFLARE_TOKEN
 */
function loadEnvIgnoreVars() {
  const envIgnorePath = path.join(__dirname, ".env.cloneignore");
  const vars = new Set();

  if (fs.existsSync(envIgnorePath)) {
    const lines = fs.readFileSync(envIgnorePath, "utf8").split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      vars.add(line);
    }
  }

  return vars;
}

// ─── .env sanitizer ──────────────────────────────────────────────────────────

/**
 * Trả về true nếu file cần qua bước sanitize .env
 * (tên file là `.env` hoặc `.env.<suffix>`, không phân biệt hoa thường)
 */
function isEnvFile(filename) {
  return /^\.env(\..+)?$/i.test(filename);
}

/**
 * Copy file .env sang dest, đồng thời xoá trắng value của các biến
 * có tên nằm trong `blankVars`.
 *
 * Giữ nguyên:
 *   - Comment (#)          →  # comment
 *   - Dòng trống           →  (giữ nguyên)
 *   - export KEY=value     →  export KEY=
 *   - KEY="value"          →  KEY=
 *   - KEY='value'          →  KEY=
 *   - KEY=value            →  KEY=
 *   - Biến không trong list →  giữ nguyên hoàn toàn
 */
function copyEnvSanitized(src, dest, blankVars) {
  if (blankVars.size === 0) {
    fs.copyFileSync(src, dest);
    return { blanked: [] };
  }

  const lines = fs.readFileSync(src, "utf8").split(/\r?\n/);
  const blanked = [];

  const result = lines.map((line) => {
    // Bỏ qua comment và dòng trống
    if (!line.trim() || line.trimStart().startsWith("#")) return line;

    // Tách optional "export " prefix + KEY + = + value
    const match = line.match(/^(\s*(?:export\s+)?)([A-Z_][A-Z0-9_]*)(\s*=\s*)(.*)$/i);
    if (!match) return line;

    const [, prefix, key, eq] = match;
    if (blankVars.has(key)) {
      blanked.push(key);
      return `${prefix}${key}${eq.trimEnd()}`; // giữ dấu = nhưng xoá value
    }
    return line;
  });

  fs.writeFileSync(dest, result.join("\n"), "utf8");
  return { blanked: [...new Set(blanked)] };
}

// ─── Clone metadata updater ──────────────────────────────────────────────────

const RENAME_TEXT_EXTENSIONS = new Set([".json", ".md", ".yml", ".yaml"]);
const TEMPLATE_NAMES = ["docker-stack-template", "docker-stack-template"];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceAllLiteral(content, from, to) {
  return content.replace(new RegExp(escapeRegex(from), "g"), to);
}

function updateCloneMetadata(filePath, serviceName) {
  if (!serviceName || !fs.existsSync(filePath)) return false;

  const ext = path.extname(filePath).toLowerCase();
  if (!RENAME_TEXT_EXTENSIONS.has(ext)) return false;

  const content = fs.readFileSync(filePath, "utf8");
  let updated = content;
  for (const templateName of TEMPLATE_NAMES) {
    updated = replaceAllLiteral(updated, templateName, serviceName);
  }

  if (updated === content) return false;

  fs.writeFileSync(filePath, updated, "utf8");
  return true;
}

function updateCloneMetadataRecursive(dir, serviceName, changed = []) {
  if (!serviceName || !fs.existsSync(dir)) return changed;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      updateCloneMetadataRecursive(fullPath, serviceName, changed);
      continue;
    }

    if (entry.isFile() && updateCloneMetadata(fullPath, serviceName)) {
      changed.push(fullPath);
    }
  }

  return changed;
}

// ─── Recursive copy ──────────────────────────────────────────────────────────

function copyRecursive(src, dest, relPath, ignoreConfig, envBlankVars) {
  const stat = fs.statSync(src);

  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      const childRel = relPath ? `${relPath}/${entry}` : entry;
      if (shouldIgnore(entry, childRel, ignoreConfig)) {
        console.log(`   ⏭  Bỏ qua: ${childRel}`);
        continue;
      }
      copyRecursive(path.join(src, entry), path.join(dest, entry), childRel, ignoreConfig, envBlankVars);
    }
    return;
  }

  const filename = path.basename(src);
  if (isEnvFile(filename) && envBlankVars.size > 0) {
    const { blanked } = copyEnvSanitized(src, dest, envBlankVars);
    if (blanked.length > 0) {
      console.log(`   🔒 Sanitized ${relPath}: xoá value của [${blanked.join(", ")}]`);
    }
    return;
  }

  fs.copyFileSync(src, dest);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(
      [
        "Usage: node scripts/clone-stack.js --output <dir> [--name <label>] [--force]",
        "",
        "  --output, -o   Thư mục đích — file sẽ được copy THẲNG vào đây",
        "  --name,   -n   Nhãn tuỳ chọn, dùng để ghi vào README stamp",
        "  --force,  -f   Ghi đè nếu thư mục đích đã tồn tại",
        "",
        "Tạo file `.cloneignore` cùng thư mục với clone-stack.js để cấu hình các entry cần bỏ qua.",
        "Tạo file `.env.cloneignore` cùng thư mục với clone-stack.js để cấu hình các biến .env cần xoá value.",
        "Ví dụ .cloneignore:",
        "  # Môi trường",
        "  .env",
        "  .env.*",
        "  # Build output",
        "  dist",
        "  build",
        "  *.log",
      ].join("\n"),
    );
    process.exit(0);
  }

  const sourceRepo = process.cwd();
  let outputDir = args.output;
  let serviceName = args.name;

  if (!outputDir) outputDir = await ask("Nhập đường dẫn output (vd: /opt/stacks/my-service): ");
  if (!serviceName) serviceName = await ask("Nhập nhãn dịch vụ (tuỳ chọn, Enter để bỏ qua): ");

  if (!outputDir) {
    console.error("❌ Thiếu output dir.");
    process.exit(1);
  }

  if (serviceName && !/^[a-zA-Z0-9._-]*$/.test(serviceName)) {
    console.error("❌ service name chỉ được chứa chữ/số/._-");
    process.exit(1);
  }

  // ── Copy thẳng vào outputDir, KHÔNG tạo subfolder theo serviceName ──────
  const targetDir = path.resolve(outputDir);

  if (fs.existsSync(targetDir)) {
    if (!args.force) {
      console.error(`❌ Thư mục đích đã tồn tại: ${targetDir}`);
      console.error("   Dùng --force để ghi đè.");
      process.exit(1);
    }
    fs.rmSync(targetDir, { recursive: true, force: true });
  }

  // ── Load ignore config ───────────────────────────────────────────────────
  const ignoreConfig = loadIgnorePatterns(sourceRepo);

  if (ignoreConfig.patterns.length) {
    console.log(`📋 Đang dùng .cloneignore (${ignoreConfig.patterns.length} pattern):`);
    ignoreConfig.patterns.forEach((p) => console.log(`   - ${p}`));
  }

  // ── Load .env sanitize config ────────────────────────────────────────────
  const envBlankVars = loadEnvIgnoreVars();

  if (envBlankVars.size > 0) {
    console.log(`🔒 Đang dùng .env.cloneignore (${envBlankVars.size} var sẽ bị xoá value):`);
    envBlankVars.forEach((v) => console.log(`   - ${v}`));
  }

  // ── Thực hiện copy ───────────────────────────────────────────────────────
  copyRecursive(sourceRepo, targetDir, "", ignoreConfig, envBlankVars);

  // ── Cập nhật metadata/tài liệu theo serviceName ──────────────────────────
  if (serviceName) {
    const changedMetadataFiles = updateCloneMetadataRecursive(targetDir, serviceName);
    for (const filePath of changedMetadataFiles) {
      console.log(`   📝 Updated clone metadata: ${path.relative(targetDir, filePath)}`);
    }
  }

  // ── Ghi stamp vào README ─────────────────────────────────────────────────
  const readmePath = path.join(targetDir, "README.md");
  if (fs.existsSync(readmePath)) {
    const label = serviceName ? ` (${serviceName})` : "";
    const stamp = `\n\n> Cloned${label} from \`${sourceRepo}\` at ${new Date().toISOString()}\n`;
    fs.appendFileSync(readmePath, stamp, "utf8");
  }

  console.log("\n✅ Clone thành công.");
  console.log(`   Source : ${sourceRepo}`);
  console.log(`   Target : ${targetDir}`);
  console.log("   Gợi ý bước tiếp theo:");
  console.log(`   - cd "${targetDir}"`);
  console.log("   - cp .env.example .env (nếu có)");
  console.log("   - npm run dockerapp-validate:env");
}

main().catch((err) => {
  console.error("❌ Lỗi clone:", err.message);
  process.exit(1);
});
