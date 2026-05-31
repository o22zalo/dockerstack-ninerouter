#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const BEGIN_MARKER = "<!-- BEGIN:EMBEDDED_FILES -->";
const END_MARKER = "<!-- END:EMBEDDED_FILES -->";

const TRACKED_FILES = [
  ".env.example",
  // 9router multi-version layer
  "compose.ninerouter.yml",
  "docker-compose/compose.ninerouter-rclone-gate.yml",
  "docker-compose/scripts/render-ninerouter.js",
  // Core / shared layers
  "docker-compose/compose.core.yml",
  "docker-compose/compose.auth.yml",
  "docker-compose/compose.ops.yml",
  "docker-compose/compose.access.yml",
  "docker-compose/compose.rclone.yml",
  "docker-compose/compose.rclone-gate.yml",
  "docker-compose/scripts/dc.sh",
  "docker-compose/scripts/validate-env.js",
  "docker-compose/scripts/validate-compose.js",
  // 9router wrapper image
  "services/9router/Dockerfile",
  "services/9router/README.md",
  "services/9router/.dockerignore",
  // Litestream / cloudflared / docs
  "services/litestream/litestream.yml",
  "services/litestream/entrypoint.sh",
  "cloudflared/config.yml.example",
  "docs/services/ninerouter.md",
  "docs/services/tinyauth.md",
  "docs/services/litestream.md",
  "docs/services/rclone.md",
];

const TREE_MAX_DEPTH = 3;
const TREE_MAX_ENTRIES_PER_DIR = 80;
const TREE_EXCLUDED_DIRS = new Set([
  ".git",
  ".docker-volumes",
  "node_modules",
  "logs",
]);

function getFenceLanguage(filePath) {
  if (filePath.endsWith(".yml") || filePath.endsWith(".yaml")) return "yaml";
  if (filePath.endsWith(".js")) return "js";
  if (filePath.endsWith(".sh")) return "bash";
  return "text";
}

function getSortedEntries(absDir) {
  return fs
    .readdirSync(absDir, { withFileTypes: true })
    .filter((entry) => !(entry.isDirectory() && TREE_EXCLUDED_DIRS.has(entry.name)))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
}

function appendTreeLines(lines, absDir, depth) {
  if (depth >= TREE_MAX_DEPTH) return;

  const entries = getSortedEntries(absDir);
  const limited = entries.slice(0, TREE_MAX_ENTRIES_PER_DIR);
  const indent = "  ".repeat(depth + 1);

  for (const entry of limited) {
    const label = entry.isDirectory() ? `${entry.name}/` : entry.name;
    lines.push(`${indent}- ${label}`);

    if (entry.isDirectory()) {
      appendTreeLines(lines, path.join(absDir, entry.name), depth + 1);
    }
  }

  if (entries.length > TREE_MAX_ENTRIES_PER_DIR) {
    lines.push(`${indent}- ... (${entries.length - TREE_MAX_ENTRIES_PER_DIR} more entries)`);
  }
}

function buildDirectorySnapshot(repoRoot) {
  const lines = ["./"];
  appendTreeLines(lines, repoRoot, 0);
  return lines.join("\n");
}

function buildEmbeddedSection(repoRoot) {
  const lines = [];
  const now = new Date().toISOString();

  lines.push(`Generated at: ${now}`);
  lines.push("Use this snapshot as direct editing context.");
  lines.push("");
  lines.push("### `DIRECTORY_STRUCTURE`");
  lines.push("```text");
  lines.push(buildDirectorySnapshot(repoRoot));
  lines.push("```");
  lines.push("");

  for (const relPath of TRACKED_FILES) {
    const absPath = path.join(repoRoot, relPath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Missing tracked file: ${relPath}`);
    }

    const lang = getFenceLanguage(relPath);
    const content = fs.readFileSync(absPath, "utf8").replace(/\r\n/g, "\n");
    const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;

    lines.push(`### \`${relPath}\``);
    lines.push(`\`\`\`${lang}`);
    lines.push(normalized);
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function syncAgentFile() {
  const repoRoot = path.resolve(__dirname, "..");
  const agentFilePath = path.join(repoRoot, "AGENT_APP_SWAP.md");

  if (!fs.existsSync(agentFilePath)) {
    throw new Error("AGENT_APP_SWAP.md not found.");
  }

  const agentContent = fs.readFileSync(agentFilePath, "utf8").replace(/\r\n/g, "\n");
  const beginIndex = agentContent.indexOf(BEGIN_MARKER);
  const endIndex = agentContent.indexOf(END_MARKER);

  if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
    throw new Error("Embedded markers not found or invalid in AGENT_APP_SWAP.md.");
  }

  const before = agentContent.slice(0, beginIndex + BEGIN_MARKER.length);
  const after = agentContent.slice(endIndex);
  const section = buildEmbeddedSection(repoRoot);
  const next = `${before}\n${section}\n${after}`;

  fs.writeFileSync(agentFilePath, next, "utf8");
  console.log(`Synced directory structure + ${TRACKED_FILES.length} files into AGENT_APP_SWAP.md`);
}

try {
  syncAgentFile();
} catch (error) {
  console.error(`sync-agent-app-swap failed: ${error.message}`);
  process.exit(1);
}
