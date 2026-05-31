const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');

const PREFIX = 'DOCKER_DEPLOY_CODE_';
const startedAt = new Date().toISOString();
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
let running = false;
let pollTimer = null;
let lastCheck = null;
let lastRun = null;

function env(name, fallback = '') {
  const value = process.env[`${PREFIX}${name}`];
  return value === undefined || value === '' ? fallback : value;
}

function bool(name, fallback = false) {
  const value = env(name, fallback ? 'true' : 'false');
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function int(name, fallback) {
  const value = Number(env(name, String(fallback)));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function list(name, fallback = '') {
  return env(name, fallback)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function config() {
  const repoDir = path.resolve(env('REPO_DIR', '/workspace'));
  const logDir = path.resolve(env('LOG_DIR', '/app/logs'));
  const tempDir = path.resolve(env('TEMP_DIR', '/tmp/deploy-code'));
  const envFile = path.resolve(repoDir, env('ENV_FILE', '.env'));
  return {
    enabled: bool('ENABLED', false),
    port: int('PORT', 53999),
    repoDir,
    branch: env('BRANCH', 'main'),
    remote: env('REMOTE', 'origin'),
    gitClean: bool('GIT_CLEAN', false),
    deployServices: list('DEPLOY_SERVICES', 'app'),
    restartContainers: list('RESTART_CONTAINERS', ''),
    composeScript: env('COMPOSE_SCRIPT', 'docker-compose/scripts/dc.sh'),
    deployCommand: env('DEPLOY_COMMAND', ''),
    postDeployCommand: env('POST_DEPLOY_COMMAND', ''),
    envFile,
    envCommitIdKey: env('ENV_COMMIT_ID_KEY', '_DOTENVRTDB_RUNNER_COMMIT_ID'),
    envCommitShortIdKey: env('ENV_COMMIT_SHORT_ID_KEY', '_DOTENVRTDB_RUNNER_COMMIT_SHORT_ID'),
    envCommitAtKey: env('ENV_COMMIT_AT_KEY', '_DOTENVRTDB_RUNNER_COMMIT_AT'),
    pollEnabled: bool('POLL_ENABLED', false),
    pollIntervalSec: int('POLL_INTERVAL_SEC', 300),
    autoDeployOnChange: bool('AUTO_DEPLOY_ON_CHANGE', false),
    runOnStart: bool('RUN_ON_START', false),
    requireToken: bool('REQUIRE_TOKEN', false),
    apiToken: env('API_TOKEN', ''),
    logDir,
    logFile: path.join(logDir, env('LOG_FILE', 'deploy-code.log')),
    tailLines: int('LOG_TAIL_LINES', 200),
    tempDir,
    zipMaxMb: int('ZIP_MAX_MB', 200),
    zipStripTopLevel: bool('ZIP_STRIP_TOP_LEVEL', true),
    zipDelete: bool('ZIP_DELETE_MISSING', false),
    zipBackupBeforeApply: bool('ZIP_BACKUP_BEFORE_APPLY', true),
    zipExcludes: list('ZIP_EXCLUDES', '.git,.env,.docker-volumes,node_modules'),
    zipDeployAfterApply: bool('ZIP_DEPLOY_AFTER_APPLY', true),
    containerControlEnabled: bool('CONTAINER_CONTROL_ENABLED', true),
    containerAllowAll: bool('CONTAINER_ALLOW_ALL', false),
    serviceAllowlist: list('SERVICE_ALLOWLIST', env('DEPLOY_SERVICES', 'app')),
    containerAllowlist: list('CONTAINER_ALLOWLIST', env('RESTART_CONTAINERS', 'main-app,deploy-code')),
    containerLogDefaultLines: int('CONTAINER_LOG_DEFAULT_LINES', 200),
    containerLogMaxLines: int('CONTAINER_LOG_MAX_LINES', 2000),
    containerActionTimeoutSec: int('CONTAINER_ACTION_TIMEOUT_SEC', 600),
  };
}

function publicConfig(cfg = config()) {
  return {
    enabled: cfg.enabled,
    repoDir: cfg.repoDir,
    branch: cfg.branch,
    remote: cfg.remote,
    gitClean: cfg.gitClean,
    deployServices: cfg.deployServices,
    restartContainers: cfg.restartContainers,
    composeScript: cfg.composeScript,
    hasDeployCommand: Boolean(cfg.deployCommand),
    hasPostDeployCommand: Boolean(cfg.postDeployCommand),
    envFile: cfg.envFile,
    pollEnabled: cfg.pollEnabled,
    pollIntervalSec: cfg.pollIntervalSec,
    autoDeployOnChange: cfg.autoDeployOnChange,
    runOnStart: cfg.runOnStart,
    requireToken: cfg.requireToken,
    tokenConfigured: Boolean(cfg.apiToken),
    logFile: cfg.logFile,
    zipMaxMb: cfg.zipMaxMb,
    zipStripTopLevel: cfg.zipStripTopLevel,
    zipDelete: cfg.zipDelete,
    zipBackupBeforeApply: cfg.zipBackupBeforeApply,
    zipDeployAfterApply: cfg.zipDeployAfterApply,
    containerControlEnabled: cfg.containerControlEnabled,
    containerAllowAll: cfg.containerAllowAll,
    serviceAllowlist: cfg.serviceAllowlist,
    containerAllowlist: cfg.containerAllowlist,
    containerLogDefaultLines: cfg.containerLogDefaultLines,
    containerLogMaxLines: cfg.containerLogMaxLines,
    containerActionTimeoutSec: cfg.containerActionTimeoutSec,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function redact(value) {
  if (!value) return value;
  return String(value).replace(/(token|secret|password|auth)=([^\s&]+)/ig, '$1=***');
}

async function ensureDirs(cfg = config()) {
  await fsp.mkdir(cfg.logDir, { recursive: true });
  await fsp.mkdir(cfg.tempDir, { recursive: true });
}

async function writeLog(level, message, meta = null) {
  const cfg = config();
  await ensureDirs(cfg).catch(() => null);
  const entry = {
    ts: nowIso(),
    level,
    message,
    ...(meta ? { meta } : {}),
  };
  const line = `${JSON.stringify(entry)}\n`;
  process.stdout.write(line);
  await fsp.appendFile(cfg.logFile, line).catch(() => null);
}

function run(command, args = [], options = {}) {
  const cfg = config();
  const cwd = options.cwd || cfg.repoDir;
  const timeoutMs = options.timeoutMs || 30 * 60 * 1000;
  const logCommand = Array.isArray(args) && args.length
    ? `${command} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`
    : command;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: Boolean(options.shell),
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);

    const collect = (streamName) => (chunk) => {
      const text = chunk.toString();
      if (streamName === 'stdout') stdout += text;
      else stderr += text;
      text.split(/\r?\n/).filter(Boolean).forEach((line) => {
        writeLog('debug', `${streamName}: ${line.slice(0, 2000)}`, { command: redact(logCommand) }).catch(() => null);
      });
    };

    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const result = { command: logCommand, code, signal, stdout, stderr };
      if (code === 0) resolve(result);
      else {
        const err = new Error(`Command failed (${code || signal}): ${logCommand}`);
        err.result = result;
        reject(err);
      }
    });
  });
}

async function runShell(command, cwd) {
  await writeLog('info', `Running shell command: ${redact(command)}`);
  return run(command, [], { cwd, shell: true });
}

async function git(args, cfg = config()) {
  await writeLog('info', `git ${args.join(' ')}`);
  return run('git', args, { cwd: cfg.repoDir });
}

async function gitText(args, cfg = config()) {
  const result = await git(args, cfg);
  return result.stdout.trim();
}

async function hasGitRepo(cfg = config()) {
  try {
    const result = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: cfg.repoDir });
    return result.stdout.trim() === 'true';
  } catch (_err) {
    return false;
  }
}

async function commitInfo(cfg = config()) {
  const inside = await hasGitRepo(cfg);
  if (!inside) return { hasGitRepo: false, localCommit: '', localShortCommit: '', branch: cfg.branch, remoteCommit: '', remoteShortCommit: '' };
  const localCommit = await gitText(['rev-parse', 'HEAD'], cfg).catch(() => '');
  const localShortCommit = await gitText(['rev-parse', '--short', 'HEAD'], cfg).catch(() => '');
  const remoteCommit = await gitText(['rev-parse', `${cfg.remote}/${cfg.branch}`], cfg).catch(() => '');
  const remoteShortCommit = remoteCommit ? remoteCommit.slice(0, 7) : '';
  return { hasGitRepo: true, localCommit, localShortCommit, branch: cfg.branch, remoteCommit, remoteShortCommit };
}

function safeEnvLine(key, value) {
  return `${key}=${String(value).replace(/\r?\n/g, '')}`;
}

async function setEnvValues(values, cfg = config()) {
  const envPath = cfg.envFile;
  let text = '';
  try {
    text = await fsp.readFile(envPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const lines = text ? text.split(/\r?\n/) : [];
  const seen = new Set();
  const next = lines.map((line) => {
    const idx = line.indexOf('=');
    if (idx <= 0 || line.trim().startsWith('#')) return line;
    const key = line.slice(0, idx).trim();
    if (!Object.prototype.hasOwnProperty.call(values, key)) return line;
    seen.add(key);
    return safeEnvLine(key, values[key]);
  });

  Object.entries(values).forEach(([key, value]) => {
    if (!seen.has(key)) next.push(safeEnvLine(key, value));
  });

  await fsp.writeFile(envPath, `${next.join('\n').replace(/\n+$/g, '')}\n`, 'utf8');
  await writeLog('info', 'Updated deployment commit values in env file.', { envFile: envPath, keys: Object.keys(values) });
}

async function updateEnvFromCommit(commit, shortCommit, cfg = config()) {
  if (!commit) return;
  await setEnvValues({
    [cfg.envCommitIdKey]: commit,
    [cfg.envCommitShortIdKey]: shortCommit || commit.slice(0, 12),
    [cfg.envCommitAtKey]: nowIso(),
  }, cfg);
}

async function detectChange(fetchRemote = true, cfg = config()) {
  if (!cfg.enabled) throw new Error('DOCKER_DEPLOY_CODE_ENABLED is not true.');
  if (!(await hasGitRepo(cfg))) throw new Error(`Repo dir is not a git work tree: ${cfg.repoDir}`);
  if (fetchRemote) await git(['fetch', cfg.remote, cfg.branch, '--prune'], cfg);
  const localCommit = await gitText(['rev-parse', 'HEAD'], cfg);
  const localShortCommit = await gitText(['rev-parse', '--short', 'HEAD'], cfg);
  const remoteCommit = await gitText(['rev-parse', `${cfg.remote}/${cfg.branch}`], cfg);
  const remoteShortCommit = remoteCommit.slice(0, 7);
  const changed = localCommit !== remoteCommit;
  const result = {
    checkedAt: nowIso(),
    changed,
    localCommit,
    localShortCommit,
    remoteCommit,
    remoteShortCommit,
    branch: cfg.branch,
    remote: cfg.remote,
  };
  lastCheck = result;
  await writeLog('info', changed ? 'Git change detected.' : 'No git change detected.', result);
  return result;
}

async function runDeployCommands(cfg = config()) {
  if (cfg.deployCommand) {
    await runShell(cfg.deployCommand, cfg.repoDir);
  } else {
    if (!cfg.deployServices.length) throw new Error('DOCKER_DEPLOY_CODE_DEPLOY_SERVICES is empty.');
    const scriptPath = path.isAbsolute(cfg.composeScript)
      ? cfg.composeScript
      : path.join(cfg.repoDir, cfg.composeScript);
    await writeLog('info', 'Rebuilding configured Docker Compose services.', { services: cfg.deployServices, composeScript: scriptPath });
    await run('bash', [scriptPath, 'up', '-d', '--build', '--no-deps', ...cfg.deployServices], { cwd: cfg.repoDir });
  }

  if (cfg.restartContainers.length) {
    await writeLog('info', 'Restarting configured containers.', { containers: cfg.restartContainers });
    await run('docker', ['restart', ...cfg.restartContainers], { cwd: cfg.repoDir });
  }

  if (cfg.postDeployCommand) {
    await runShell(cfg.postDeployCommand, cfg.repoDir);
  }
}

function cleanDockerName(value) {
  return String(value || '').trim().replace(/^\/+/, '');
}

function parseTargetList(value) {
  if (Array.isArray(value)) return value.map(cleanDockerName).filter(Boolean);
  return String(value || '').split(',').map(cleanDockerName).filter(Boolean);
}

function uniqueList(items) {
  return Array.from(new Set((items || []).map(cleanDockerName).filter(Boolean)));
}

function validateTargetName(name, type = 'target') {
  if (!/^[a-zA-Z0-9_.:@-]+$/.test(String(name || ''))) {
    throw new Error(`Invalid ${type} name: ${name}`);
  }
}

function parseDockerLabels(labelsText) {
  const labels = {};
  String(labelsText || '').split(',').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx <= 0) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) labels[key] = value;
  });
  return labels;
}

function normalizeDockerContainer(row) {
  const labels = parseDockerLabels(row.Labels || '');
  const names = String(row.Names || '').split(',').map(cleanDockerName).filter(Boolean);
  return {
    id: row.ID || '',
    image: row.Image || '',
    names,
    name: names[0] || '',
    command: row.Command || '',
    createdAt: row.CreatedAt || '',
    runningFor: row.RunningFor || '',
    ports: row.Ports || '',
    state: row.State || '',
    status: row.Status || '',
    labels,
    composeProject: labels['com.docker.compose.project'] || '',
    composeService: labels['com.docker.compose.service'] || '',
    networks: row.Networks || '',
  };
}

function allowedServicesSet(cfg = config()) {
  return new Set(uniqueList([...(cfg.serviceAllowlist || []), ...(cfg.deployServices || [])]));
}

function allowedContainersSet(cfg = config()) {
  const configuredName = env('CONTAINER_NAME', 'deploy-code');
  return new Set(uniqueList([...(cfg.containerAllowlist || []), ...(cfg.restartContainers || []), configuredName]));
}

function isAllowedService(service, cfg = config()) {
  const name = cleanDockerName(service);
  if (!name) return false;
  if (cfg.containerAllowAll) return true;
  return allowedServicesSet(cfg).has(name);
}

function isAllowedContainer(container, cfg = config()) {
  const name = cleanDockerName(container?.name || container);
  if (!name) return false;
  if (cfg.containerAllowAll) return true;
  const allowedContainers = allowedContainersSet(cfg);
  if (allowedContainers.has(name)) return true;
  if (container?.names?.some((item) => allowedContainers.has(item))) return true;
  return Boolean(container?.composeService && isAllowedService(container.composeService, cfg));
}

function assertContainerControlEnabled(cfg = config()) {
  if (!cfg.enabled) throw new Error('DOCKER_DEPLOY_CODE_ENABLED is not true.');
  if (!cfg.containerControlEnabled) throw new Error('DOCKER_DEPLOY_CODE_CONTAINER_CONTROL_ENABLED is not true.');
}

async function listDockerContainers(cfg = config()) {
  assertContainerControlEnabled(cfg);
  const result = await run('docker', ['ps', '-a', '--format', '{{json .}}'], {
    cwd: cfg.repoDir,
    timeoutMs: cfg.containerActionTimeoutSec * 1000,
  });
  return result.stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return normalizeDockerContainer(JSON.parse(line)); }
      catch (_err) { return null; }
    })
    .filter(Boolean);
}

async function listComposeServices(cfg = config()) {
  assertContainerControlEnabled(cfg);
  const scriptPath = path.isAbsolute(cfg.composeScript)
    ? cfg.composeScript
    : path.join(cfg.repoDir, cfg.composeScript);
  const result = await run('bash', [scriptPath, 'config', '--services'], {
    cwd: cfg.repoDir,
    timeoutMs: cfg.containerActionTimeoutSec * 1000,
  });
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((name) => ({
    name,
    allowed: isAllowedService(name, cfg),
  }));
}

async function publicContainersPayload(includeAll = false, cfg = config()) {
  const containers = await listDockerContainers(cfg);
  const visible = cfg.containerAllowAll && includeAll
    ? containers
    : containers.filter((item) => isAllowedContainer(item, cfg));
  return {
    ok: true,
    generatedAt: nowIso(),
    allowAll: cfg.containerAllowAll,
    allowedServices: Array.from(allowedServicesSet(cfg)),
    allowedContainers: Array.from(allowedContainersSet(cfg)),
    containers: visible.map((item) => ({
      ...item,
      allowed: isAllowedContainer(item, cfg),
    })),
  };
}

function requireAllowedServices(services, cfg = config()) {
  const targets = uniqueList(services);
  targets.forEach((service) => {
    validateTargetName(service, 'service');
    if (!isAllowedService(service, cfg)) {
      throw new Error(`Service is not allowed by DOCKER_DEPLOY_CODE_SERVICE_ALLOWLIST: ${service}`);
    }
  });
  return targets;
}

async function requireAllowedContainers(containers, cfg = config()) {
  const targets = uniqueList(containers);
  targets.forEach((container) => validateTargetName(container, 'container'));
  if (cfg.containerAllowAll) return targets;

  const existing = await listDockerContainers(cfg);
  const problems = [];
  targets.forEach((target) => {
    const hit = existing.find((item) => item.id.startsWith(target) || item.names.includes(target));
    if (!hit) {
      if (!allowedContainersSet(cfg).has(target)) problems.push(`${target} (not found)`);
      return;
    }
    if (!isAllowedContainer(hit, cfg)) problems.push(target);
  });
  if (problems.length) {
    throw new Error(`Container is not allowed by DOCKER_DEPLOY_CODE_CONTAINER_ALLOWLIST/service allowlist: ${problems.join(', ')}`);
  }
  return targets;
}

async function inferServicesFromContainers(containers, cfg = config()) {
  const targets = await requireAllowedContainers(containers, cfg);
  const existing = await listDockerContainers(cfg);
  const services = [];
  targets.forEach((target) => {
    const hit = existing.find((item) => item.id.startsWith(target) || item.names.includes(target));
    if (hit?.composeService) services.push(hit.composeService);
  });
  return requireAllowedServices(services, cfg);
}

async function runComposeForServices(args, cfg = config()) {
  const scriptPath = path.isAbsolute(cfg.composeScript)
    ? cfg.composeScript
    : path.join(cfg.repoDir, cfg.composeScript);
  await writeLog('info', `docker compose ${args.join(' ')}`);
  return run('bash', [scriptPath, ...args], {
    cwd: cfg.repoDir,
    timeoutMs: cfg.containerActionTimeoutSec * 1000,
  });
}

async function runDockerContainerAction(action, containers, cfg = config()) {
  const allowedActions = new Set(['start', 'stop', 'restart']);
  if (!allowedActions.has(action)) throw new Error(`Unsupported docker container action: ${action}`);
  const targets = await requireAllowedContainers(containers, cfg);
  if (!targets.length) return null;
  await writeLog('info', `docker ${action} containers.`, { containers: targets });
  return run('docker', [action, ...targets], {
    cwd: cfg.repoDir,
    timeoutMs: cfg.containerActionTimeoutSec * 1000,
  });
}

async function runServiceAction(action, services, cfg = config()) {
  const targets = requireAllowedServices(services, cfg);
  if (!targets.length) return null;
  if (action === 'start' || action === 'restart' || action === 'up' || action === 'rebuild') {
    const composeConfig = await runComposeForServices(['config', '--format', 'json'], cfg);
    let serviceMap = {};
    try {
      serviceMap = JSON.parse(composeConfig.stdout || '{}')?.services || {};
    } catch (_err) {
      serviceMap = {};
    }
    const buildTargets = targets.filter((name) => Boolean(serviceMap?.[name]?.build));
    const plainTargets = targets.filter((name) => !buildTargets.includes(name));

    if (buildTargets.length) {
      await runComposeForServices(['up', '-d', '--build', '--no-deps', ...buildTargets], cfg);
    }
    if (plainTargets.length) {
      if (action === 'start' || action === 'up') {
        await runComposeForServices(['up', '-d', '--no-deps', ...plainTargets], cfg);
      } else if (action === 'restart' || action === 'rebuild') {
        await runComposeForServices(['restart', ...plainTargets], cfg);
      }
    }
    return { code: 0, command: `compose ${action}`, stdout: '', stderr: '' };
  }
  if (action === 'stop') return runComposeForServices(['stop', ...targets], cfg);
  throw new Error(`Unsupported compose service action: ${action}`);
}

function summarizeCommandResult(result) {
  if (!result) return null;
  return {
    command: redact(result.command || ''),
    code: result.code,
    signal: result.signal || '',
    stdout: String(result.stdout || '').slice(-12000),
    stderr: String(result.stderr || '').slice(-12000),
  };
}

async function controlTargets(action, body = {}, cfg = config()) {
  assertContainerControlEnabled(cfg);
  if (running) throw new Error('Deploy/container operation is already running.');
  const normalizedAction = String(action || body.action || '').trim().toLowerCase();
  const services = parseTargetList(body.services || body.service || '');
  let containers = parseTargetList(body.containers || body.container || '');
  if (!normalizedAction) throw new Error('Missing container action.');

  running = true;
  const started = nowIso();
  try {
    await writeLog('info', 'Starting container/service control action.', { action: normalizedAction, services, containers });
    const results = [];

    if ((normalizedAction === 'start' || normalizedAction === 'restart' || normalizedAction === 'rebuild')
      && containers.length) {
      const allowedTargets = await requireAllowedContainers(containers, cfg);
      const existing = await listDockerContainers(cfg);
      const inferredServices = [];
      const rawContainers = [];
      allowedTargets.forEach((target) => {
        const hit = existing.find((item) => item.id.startsWith(target) || item.names.includes(target));
        if (hit?.composeService) inferredServices.push(hit.composeService);
        else rawContainers.push(target);
      });
      if (inferredServices.length) {
        services.push(...requireAllowedServices(inferredServices, cfg));
      }
      containers = uniqueList(rawContainers);
    }

    if (services.length) {
      const result = await runServiceAction(normalizedAction, services, cfg);
      results.push({ targetType: 'service', targets: uniqueList(services), result: summarizeCommandResult(result) });
    }

    if (containers.length) {
      if (normalizedAction === 'up') {
        throw new Error(`${normalizedAction} must target compose services, not raw containers.`);
      }
      const containerAction = normalizedAction === 'rebuild' ? 'restart' : normalizedAction;
      const result = await runDockerContainerAction(containerAction, containers, cfg);
      results.push({ targetType: 'container', targets: uniqueList(containers), result: summarizeCommandResult(result) });
    }

    if (!results.length) throw new Error('No services or containers were provided.');

    lastRun = {
      type: 'container-control',
      status: 'ok',
      action: normalizedAction,
      startedAt: started,
      finishedAt: nowIso(),
      services: uniqueList(services),
      containers: uniqueList(containers),
      results,
    };
    await writeLog('info', 'Container/service control action finished.', lastRun);
    return lastRun;
  } catch (err) {
    lastRun = {
      type: 'container-control',
      status: 'error',
      action: normalizedAction,
      startedAt: started,
      finishedAt: nowIso(),
      services,
      containers,
      error: err.message,
      command: err.result?.command,
      stderr: err.result?.stderr?.slice(-4000),
    };
    await writeLog('error', 'Container/service control action failed.', lastRun);
    throw err;
  } finally {
    running = false;
  }
}

function boundedLogLines(value, cfg = config()) {
  const n = Number(value || cfg.containerLogDefaultLines);
  if (!Number.isFinite(n) || n <= 0) return cfg.containerLogDefaultLines;
  return Math.min(Math.floor(n), cfg.containerLogMaxLines);
}

async function readTargetLogs(body = {}, cfg = config()) {
  assertContainerControlEnabled(cfg);
  const services = requireAllowedServices(parseTargetList(body.services || body.service || ''), cfg);
  const containers = await requireAllowedContainers(parseTargetList(body.containers || body.container || ''), cfg);
  const lines = boundedLogLines(body.lines, cfg);
  const since = cleanDockerName(body.since || '');
  const items = [];
  if (!services.length && !containers.length) throw new Error('No services or containers were provided for logs.');

  if (services.length) {
    const args = ['logs', '--no-color', '--tail', String(lines)];
    if (since) args.push('--since', since);
    args.push(...services);
    const result = await runComposeForServices(args, cfg);
    items.push({ targetType: 'service', targets: services, logs: result.stdout || result.stderr || '' });
  }

  for (const container of containers) {
    const args = ['logs', '--tail', String(lines)];
    if (since) args.push('--since', since);
    args.push(container);
    const result = await run('docker', args, {
      cwd: cfg.repoDir,
      timeoutMs: cfg.containerActionTimeoutSec * 1000,
    }).catch((err) => ({ stdout: err.result?.stdout || '', stderr: err.result?.stderr || err.message }));
    items.push({ targetType: 'container', targets: [container], logs: `${result.stdout || ''}${result.stderr || ''}` });
  }

  return { ok: true, generatedAt: nowIso(), lines, items };
}

async function inspectContainers(body = {}, cfg = config()) {
  assertContainerControlEnabled(cfg);
  const containers = await requireAllowedContainers(parseTargetList(body.containers || body.container || ''), cfg);
  if (!containers.length) throw new Error('No containers were provided for inspect.');
  const result = await run('docker', ['inspect', ...containers], {
    cwd: cfg.repoDir,
    timeoutMs: cfg.containerActionTimeoutSec * 1000,
  });
  let data = [];
  try { data = JSON.parse(result.stdout || '[]'); } catch (_err) { data = []; }
  return { ok: true, generatedAt: nowIso(), containers, inspect: data };
}


async function deployFromGit(options = {}) {
  const cfg = config();
  if (running) throw new Error('Deploy is already running.');
  running = true;
  const started = nowIso();
  try {
    await ensureDirs(cfg);
    await writeLog('info', 'Starting git deploy.', { force: Boolean(options.force) });
    const change = await detectChange(true, cfg);
    if (!change.changed && !options.force) {
      lastRun = { type: 'git', status: 'no-change', startedAt: started, finishedAt: nowIso(), change };
      return lastRun;
    }

    await git(['reset', '--hard', `${cfg.remote}/${cfg.branch}`], cfg);
    if (cfg.gitClean) {
      await git(['clean', '-fd', '-e', '.env', '-e', '.docker-volumes'], cfg);
    }

    const info = await commitInfo(cfg);
    await updateEnvFromCommit(info.localCommit, info.localShortCommit, cfg);
    await runDeployCommands(cfg);

    lastRun = { type: 'git', status: 'deployed', startedAt: started, finishedAt: nowIso(), change, commit: info.localCommit, shortCommit: info.localShortCommit };
    await writeLog('info', 'Git deploy finished.', lastRun);
    return lastRun;
  } catch (err) {
    lastRun = { type: 'git', status: 'error', startedAt: started, finishedAt: nowIso(), error: err.message, command: err.result?.command, stderr: err.result?.stderr?.slice(-4000) };
    await writeLog('error', 'Git deploy failed.', lastRun);
    throw err;
  } finally {
    running = false;
  }
}

async function tailLog(lines = config().tailLines) {
  const cfg = config();
  try {
    const stat = await fsp.stat(cfg.logFile);
    const size = Math.min(stat.size, 1024 * 1024);
    const fh = await fsp.open(cfg.logFile, 'r');
    const buffer = Buffer.alloc(size);
    await fh.read(buffer, 0, size, stat.size - size);
    await fh.close();
    return buffer.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch (_err) {
    return '';
  }
}

function responseJson(res, status, data) {
  const text = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-deploy-code-token, x-file-name',
  });
  res.end(text);
}

function responseText(res, status, text) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-deploy-code-token, x-file-name',
  });
  res.end(text);
}

function staticRelativePath(urlPath) {
  if (urlPath === '/' || urlPath === '/ui' || urlPath === '/ui/') return 'index.html';
  if (urlPath.startsWith('/ui/')) return urlPath.slice('/ui/'.length);

  // Serve common static assets from the root of PUBLIC_DIR
  const ext = path.extname(urlPath).toLowerCase();
  if (['.css', '.js', '.png', '.jpg', '.svg', '.ico'].includes(ext)) {
    return urlPath.slice(1);
  }
  return '';
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const relative = staticRelativePath(url.pathname);
  if (!relative) return false;

  const normalized = path.normalize(relative).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.resolve(PUBLIC_DIR, normalized);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    return false;
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (_err) {
    return false;
  }
  if (!stat.isFile()) return false;

  res.writeHead(200, {
    'content-type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=300',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function apiPathname(pathname) {
  if (pathname === '/api' || pathname === '/api/') return '/status';
  if (pathname.startsWith('/api/')) return pathname.slice('/api'.length);
  return pathname;
}

function parseJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isAuthorized(req, cfg = config()) {
  if (!cfg.requireToken && !cfg.apiToken) return true;
  if (!cfg.apiToken) return false;
  const headerToken = req.headers['x-deploy-code-token'] || '';
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  return timingSafeEqualString(headerToken || bearer, cfg.apiToken);
}

function sanitizeZipFileName(name) {
  const safe = String(name || 'source.zip').split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe.endsWith('.zip') ? safe : `${safe}.zip`;
}

async function saveZipUpload(req, cfg = config()) {
  await ensureDirs(cfg);
  const maxBytes = cfg.zipMaxMb * 1024 * 1024;
  const fileName = sanitizeZipFileName(req.headers['x-file-name'] || `source-${Date.now()}.zip`);
  const zipPath = path.join(cfg.tempDir, `${Date.now()}-${fileName}`);
  const output = fs.createWriteStream(zipPath, { flags: 'wx' });
  let size = 0;

  return new Promise((resolve, reject) => {
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        output.destroy();
        req.destroy();
        reject(new Error(`ZIP exceeds DOCKER_DEPLOY_CODE_ZIP_MAX_MB=${cfg.zipMaxMb}.`));
        return;
      }
    });
    req.pipe(output);
    output.on('finish', () => resolve({ zipPath, size, fileName }));
    output.on('error', reject);
    req.on('error', reject);
  });
}

async function findZipSourceDir(extractDir, cfg = config()) {
  if (!cfg.zipStripTopLevel) return extractDir;
  const entries = (await fsp.readdir(extractDir, { withFileTypes: true }))
    .filter((entry) => !entry.name.startsWith('__MACOSX'));
  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(extractDir, entries[0].name);
  }
  return extractDir;
}

async function backupRepo(cfg = config()) {
  const backupDir = path.resolve(env('BACKUP_DIR', '/app/backups'));
  await fsp.mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `repo-before-zip-${Date.now()}.tar.gz`);
  const excludes = cfg.zipExcludes.flatMap((item) => ['--exclude', item]);
  await writeLog('info', 'Creating backup before zip apply.', { backupPath });
  await run('tar', ['-czf', backupPath, ...excludes, '-C', cfg.repoDir, '.'], { cwd: cfg.repoDir });
  return backupPath;
}

async function applyZip(zipPath, cfg = config()) {
  const extractDir = path.join(cfg.tempDir, `extract-${Date.now()}`);
  await fsp.mkdir(extractDir, { recursive: true });
  await writeLog('info', 'Extracting zip source.', { zipPath, extractDir });
  await run('unzip', ['-q', '-o', zipPath, '-d', extractDir], { cwd: cfg.repoDir });
  const sourceDir = await findZipSourceDir(extractDir, cfg);
  const excludes = cfg.zipExcludes.flatMap((item) => ['--exclude', item]);
  const deleteArg = cfg.zipDelete ? ['--delete'] : [];
  const sourceWithSlash = sourceDir.endsWith(path.sep) ? sourceDir : `${sourceDir}${path.sep}`;
  await writeLog('info', 'Applying zip source with rsync.', { sourceDir, repoDir: cfg.repoDir, deleteMissing: cfg.zipDelete, excludes: cfg.zipExcludes });
  await run('rsync', ['-a', ...deleteArg, ...excludes, sourceWithSlash, `${cfg.repoDir}${path.sep}`], { cwd: cfg.repoDir });
  await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => null);
}

async function deployFromZip(req) {
  const cfg = config();
  if (!cfg.enabled) throw new Error('DOCKER_DEPLOY_CODE_ENABLED is not true.');
  if (running) throw new Error('Deploy is already running.');
  running = true;
  const started = nowIso();
  let zipInfo = null;
  try {
    await writeLog('info', 'Starting zip deploy upload.');
    zipInfo = await saveZipUpload(req, cfg);
    let backupPath = '';
    if (cfg.zipBackupBeforeApply) backupPath = await backupRepo(cfg);
    await applyZip(zipInfo.zipPath, cfg);

    const info = await commitInfo(cfg);
    if (info.localCommit) {
      await updateEnvFromCommit(info.localCommit, info.localShortCommit, cfg);
    } else {
      const zipVersion = `zip-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
      await setEnvValues({
        [cfg.envCommitIdKey]: zipVersion,
        [cfg.envCommitShortIdKey]: zipVersion,
        [cfg.envCommitAtKey]: nowIso(),
      }, cfg);
    }

    if (cfg.zipDeployAfterApply) await runDeployCommands(cfg);
    await fsp.rm(zipInfo.zipPath, { force: true }).catch(() => null);
    lastRun = {
      type: 'zip',
      status: cfg.zipDeployAfterApply ? 'deployed' : 'applied',
      startedAt: started,
      finishedAt: nowIso(),
      size: zipInfo.size,
      fileName: zipInfo.fileName,
      backupPath,
      commit: info.localCommit || '',
      shortCommit: info.localShortCommit || '',
    };
    await writeLog('info', 'Zip deploy finished.', lastRun);
    return lastRun;
  } catch (err) {
    lastRun = { type: 'zip', status: 'error', startedAt: started, finishedAt: nowIso(), fileName: zipInfo?.fileName || '', error: err.message, command: err.result?.command, stderr: err.result?.stderr?.slice(-4000) };
    await writeLog('error', 'Zip deploy failed.', lastRun);
    throw err;
  } finally {
    running = false;
  }
}

async function statusPayload() {
  const cfg = config();
  return {
    status: 'ok',
    service: 'deploy-code',
    startedAt,
    generatedAt: nowIso(),
    running,
    config: publicConfig(cfg),
    git: await commitInfo(cfg).catch((err) => ({ error: err.message })),
    lastCheck,
    lastRun,
    logs: await tailLog(cfg.tailLines),
  };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const cfg = config();
  const pathname = apiPathname(url.pathname);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization, x-deploy-code-token, x-file-name',
    });
    return res.end();
  }

  if (pathname === '/health') {
    return responseJson(res, 200, { status: 'ok', enabled: cfg.enabled, running, startedAt });
  }

  if (await serveStatic(req, res, url)) {
    return;
  }

  if (!isAuthorized(req, cfg)) {
    return responseJson(res, 401, { error: 'Unauthorized deploy-code request.' });
  }

  if (pathname === '/status') {
    return responseJson(res, 200, await statusPayload());
  }

  if (pathname === '/logs') {
    return responseText(res, 200, await tailLog(Number(url.searchParams.get('lines')) || cfg.tailLines));
  }

  if (pathname === '/check' && req.method === 'POST') {
    const body = await parseJsonBody(req).catch(() => ({}));
    const result = await detectChange(body.fetch !== false, cfg);
    return responseJson(res, 200, { ok: true, result, status: await statusPayload() });
  }

  if (pathname === '/deploy' && req.method === 'POST') {
    const body = await parseJsonBody(req).catch(() => ({}));
    const result = await deployFromGit({ force: Boolean(body.force) });
    return responseJson(res, 200, { ok: true, result, status: await statusPayload() });
  }

  if (pathname === '/upload-zip' && req.method === 'POST') {
    const result = await deployFromZip(req);
    return responseJson(res, 200, { ok: true, result, status: await statusPayload() });
  }

  if (pathname === '/services' && req.method === 'GET') {
    return responseJson(res, 200, { ok: true, generatedAt: nowIso(), services: await listComposeServices(cfg) });
  }

  if (pathname === '/containers' && req.method === 'GET') {
    const includeAll = ['1', 'true', 'yes'].includes(String(url.searchParams.get('all') || '').toLowerCase());
    return responseJson(res, 200, await publicContainersPayload(includeAll, cfg));
  }

  if (pathname === '/containers/logs' && req.method === 'GET') {
    const result = await readTargetLogs({
      services: url.searchParams.get('services') || url.searchParams.get('service') || '',
      containers: url.searchParams.get('containers') || url.searchParams.get('container') || '',
      lines: url.searchParams.get('lines') || '',
      since: url.searchParams.get('since') || '',
    }, cfg);
    return responseJson(res, 200, result);
  }

  if (pathname === '/containers/logs' && req.method === 'POST') {
    const body = await parseJsonBody(req).catch(() => ({}));
    return responseJson(res, 200, await readTargetLogs(body, cfg));
  }

  if (pathname === '/containers/inspect' && req.method === 'GET') {
    const result = await inspectContainers({
      containers: url.searchParams.get('containers') || url.searchParams.get('container') || '',
    }, cfg);
    return responseJson(res, 200, result);
  }

  if (pathname === '/containers/inspect' && req.method === 'POST') {
    const body = await parseJsonBody(req).catch(() => ({}));
    return responseJson(res, 200, await inspectContainers(body, cfg));
  }

  if (pathname === '/containers/action' && req.method === 'POST') {
    const body = await parseJsonBody(req).catch(() => ({}));
    const result = await controlTargets(body.action, body, cfg);
    return responseJson(res, 200, { ok: true, result, status: await statusPayload() });
  }

  const actionMatch = pathname.match(/^\/containers\/(start|stop|restart|rebuild|up)$/);
  if (actionMatch && req.method === 'POST') {
    const body = await parseJsonBody(req).catch(() => ({}));
    const result = await controlTargets(actionMatch[1], body, cfg);
    return responseJson(res, 200, { ok: true, result, status: await statusPayload() });
  }

  return responseJson(res, 404, { error: 'deploy-code endpoint not found.' });
}

async function pollOnce(reason = 'poll') {
  const cfg = config();
  if (!cfg.enabled || !cfg.pollEnabled || running) return;
  try {
    await writeLog('info', `Polling git change: ${reason}`);
    const change = await detectChange(true, cfg);
    if (change.changed && cfg.autoDeployOnChange) {
      await deployFromGit({ force: false });
    }
  } catch (err) {
    await writeLog('error', 'Polling failed.', { error: err.message });
  }
}

async function start() {
  const cfg = config();
  await ensureDirs(cfg);
  await writeLog('info', 'deploy-code sidecar starting.', { config: publicConfig(cfg) });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      writeLog('error', 'Request failed.', { method: req.method, url: req.url, error: err.message }).catch(() => null);
      responseJson(res, err.message.includes('already running') ? 409 : 500, { error: err.message, lastRun });
    });
  });

  server.listen(cfg.port, '0.0.0.0', () => {
    writeLog('info', `deploy-code sidecar listening on :${cfg.port}`).catch(() => null);
  });

  if (cfg.pollEnabled) {
    if (cfg.runOnStart) pollOnce('startup').catch(() => null);
    pollTimer = setInterval(() => pollOnce('interval'), cfg.pollIntervalSec * 1000);
    pollTimer.unref();
  }
}

process.on('SIGTERM', () => {
  writeLog('info', 'Received SIGTERM, shutting down.').finally(() => process.exit(0));
});

process.on('SIGINT', () => {
  writeLog('info', 'Received SIGINT, shutting down.').finally(() => process.exit(0));
});

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
