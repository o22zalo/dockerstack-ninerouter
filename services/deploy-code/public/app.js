const state = {
  token: localStorage.getItem('deployCodeToken') || '',
  status: null,
  services: [],
  containers: [],
  busy: false,
};

const $ = (selector) => document.querySelector(selector);
const els = {
  tokenInput: $('#tokenInput'),
  saveTokenBtn: $('#saveTokenBtn'),
  refreshBtn: $('#refreshBtn'),
  checkBtn: $('#checkBtn'),
  deployBtn: $('#deployBtn'),
  forceDeployBtn: $('#forceDeployBtn'),
  uploadBtn: $('#uploadBtn'),
  zipInput: $('#zipInput'),
  servicesBtn: $('#servicesBtn'),
  containersBtn: $('#containersBtn'),
  logsBtn: $('#logsBtn'),
  logLinesInput: $('#logLinesInput'),
  statusBadge: $('#statusBadge'),
  runningBadge: $('#runningBadge'),
  statusGrid: $('#statusGrid'),
  lastRunBox: $('#lastRunBox'),
  servicesList: $('#servicesList'),
  containersList: $('#containersList'),
  logsBox: $('#logsBox'),
  toast: $('#toast'),
};

els.tokenInput.value = state.token;

function setBusy(value) {
  state.busy = value;
  [
    els.refreshBtn,
    els.checkBtn,
    els.deployBtn,
    els.forceDeployBtn,
    els.uploadBtn,
    els.servicesBtn,
    els.containersBtn,
    els.logsBtn,
  ].forEach((button) => {
    button.disabled = value;
  });
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove('show'), 3200);
}

function tokenHeaders() {
  const headers = {};
  if (state.token) headers['x-deploy-code-token'] = state.token;
  return headers;
}

async function api(path, options = {}) {
  const headers = {
    ...tokenHeaders(),
    ...(options.headers || {}),
  };
  const init = {
    ...options,
    headers,
  };
  if (options.json !== undefined) {
    init.body = JSON.stringify(options.json);
    init.headers = {
      ...headers,
      'content-type': 'application/json',
    };
  }

  const response = await fetch(`/api${path}`, init);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : await response.text();

  if (!response.ok) {
    const message = typeof payload === 'string' ? payload : payload.error || response.statusText;
    const error = new Error(message || 'Request failed.');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function compactJson(value) {
  if (!value) return '';
  return JSON.stringify(value, null, 2);
}

function short(value, length = 12) {
  const text = String(value || '');
  return text.length > length ? text.slice(0, length) : text;
}

function classForStatus(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('running') || text.includes('healthy') || text === 'ok' || text === 'true') return 'ok';
  if (text.includes('exited') || text.includes('error') || text.includes('false') || text.includes('dead')) return 'bad';
  if (text.includes('created') || text.includes('paused') || text.includes('restarting')) return 'warn';
  return 'neutral';
}

function metric(label, value) {
  const item = document.createElement('div');
  item.className = 'metric';
  item.innerHTML = `<span>${label}</span><strong>${value || '-'}</strong>`;
  return item;
}

function renderStatus() {
  const data = state.status;
  if (!data) {
    els.statusBadge.textContent = 'Unknown';
    els.statusBadge.className = 'badge neutral';
    els.runningBadge.textContent = 'Idle';
    els.runningBadge.className = 'badge neutral';
    els.statusGrid.innerHTML = '';
    els.lastRunBox.textContent = 'No status loaded.';
    return;
  }

  const cfg = data.config || {};
  els.statusBadge.textContent = cfg.enabled ? 'Enabled' : 'Disabled';
  els.statusBadge.className = `badge ${cfg.enabled ? 'ok' : 'warn'}`;
  els.runningBadge.textContent = data.running ? 'Running' : 'Idle';
  els.runningBadge.className = `badge ${data.running ? 'warn' : 'ok'}`;

  els.statusGrid.replaceChildren(
    metric('Repo', cfg.repoDir),
    metric('Branch', `${cfg.remote || 'origin'}/${cfg.branch || 'main'}`),
    metric('Local', short(data.git?.localCommit || data.git?.error || '')),
    metric('Remote', short(data.git?.remoteCommit || '')),
    metric('Services', (cfg.deployServices || []).join(', ')),
    metric('Allowlist', (cfg.serviceAllowlist || []).join(', ')),
    metric('Polling', cfg.pollEnabled ? `${cfg.pollIntervalSec}s` : 'off'),
    metric('Token', cfg.tokenConfigured ? 'configured' : 'missing'),
  );

  els.lastRunBox.textContent = compactJson(data.lastRun || data.lastCheck || { status: 'No deploy action yet.' });
  els.logsBox.textContent = data.logs || '';
}

function renderServices() {
  if (!state.services.length) {
    els.servicesList.innerHTML = '<div class="empty">No services loaded.</div>';
    return;
  }
  els.servicesList.replaceChildren(...state.services.map((service) => {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `
      <div>
        <div class="item-title">
          <strong>${service.name}</strong>
          <span class="badge ${service.allowed ? 'ok' : 'neutral'}">${service.allowed ? 'allowed' : 'locked'}</span>
        </div>
        <div class="item-meta">Compose service</div>
      </div>
      <div class="item-actions">
        <button class="secondary compact" data-service-action="start" data-service="${service.name}" ${service.allowed ? '' : 'disabled'}>Start</button>
        <button class="secondary compact" data-service-action="restart" data-service="${service.name}" ${service.allowed ? '' : 'disabled'}>Restart</button>
        <button class="secondary compact" data-service-action="rebuild" data-service="${service.name}" ${service.allowed ? '' : 'disabled'}>Rebuild</button>
        <button class="danger compact" data-service-action="stop" data-service="${service.name}" ${service.allowed ? '' : 'disabled'}>Stop</button>
      </div>
    `;
    return row;
  }));
}

function renderContainers() {
  if (!state.containers.length) {
    els.containersList.innerHTML = '<div class="empty">No containers loaded.</div>';
    return;
  }
  els.containersList.replaceChildren(...state.containers.map((container) => {
    const row = document.createElement('div');
    row.className = 'item';
    const statusClass = classForStatus(container.state || container.status);
    row.innerHTML = `
      <div>
        <div class="item-title">
          <strong>${container.name || container.id}</strong>
          <span class="badge ${statusClass}">${container.state || 'unknown'}</span>
          <span class="badge ${container.allowed ? 'ok' : 'neutral'}">${container.allowed ? 'allowed' : 'locked'}</span>
        </div>
        <div class="item-meta">${container.composeService || 'container'} | ${container.image || '-'} | ${container.status || '-'}</div>
      </div>
      <div class="item-actions">
        <button class="secondary compact" data-container-logs="${container.name}" ${container.allowed ? '' : 'disabled'}>Logs</button>
        <button class="secondary compact" data-container-action="start" data-container="${container.name}" ${container.allowed ? '' : 'disabled'}>Start</button>
        <button class="secondary compact" data-container-action="restart" data-container="${container.name}" ${container.allowed ? '' : 'disabled'}>Restart</button>
        <button class="danger compact" data-container-action="stop" data-container="${container.name}" ${container.allowed ? '' : 'disabled'}>Stop</button>
      </div>
    `;
    return row;
  }));
}

async function refreshStatus() {
  const data = await api('/status');
  state.status = data;
  renderStatus();
}

async function loadServices() {
  const data = await api('/services');
  state.services = data.services || [];
  renderServices();
}

async function loadContainers() {
  const data = await api('/containers');
  state.containers = data.containers || [];
  renderContainers();
}

async function refreshAll() {
  setBusy(true);
  try {
    await refreshStatus();
    await Promise.all([
      loadServices().catch((err) => {
        els.servicesList.innerHTML = `<div class="empty">${err.message}</div>`;
      }),
      loadContainers().catch((err) => {
        els.containersList.innerHTML = `<div class="empty">${err.message}</div>`;
      }),
    ]);
    toast('Status refreshed.');
  } catch (err) {
    state.status = null;
    renderStatus();
    toast(err.status === 401 ? 'Token required or invalid.' : err.message);
  } finally {
    setBusy(false);
  }
}

async function runAction(label, fn) {
  setBusy(true);
  try {
    const result = await fn();
    if (result.status) state.status = result.status;
    else await refreshStatus().catch(() => null);
    renderStatus();
    toast(`${label} finished.`);
    return result;
  } catch (err) {
    toast(`${label} failed: ${err.message}`);
    throw err;
  } finally {
    setBusy(false);
  }
}

async function loadDeployLogs() {
  setBusy(true);
  try {
    const lines = Number(els.logLinesInput.value || 200);
    els.logsBox.textContent = await api(`/logs?lines=${encodeURIComponent(lines)}`);
    toast('Logs loaded.');
  } catch (err) {
    toast(err.message);
  } finally {
    setBusy(false);
  }
}

els.saveTokenBtn.addEventListener('click', () => {
  state.token = els.tokenInput.value.trim();
  if (state.token) localStorage.setItem('deployCodeToken', state.token);
  else localStorage.removeItem('deployCodeToken');
  toast('Token saved.');
  refreshAll();
});

els.refreshBtn.addEventListener('click', refreshAll);
els.servicesBtn.addEventListener('click', () => runAction('Reload services', loadServices));
els.containersBtn.addEventListener('click', () => runAction('Reload containers', loadContainers));
els.logsBtn.addEventListener('click', loadDeployLogs);

els.checkBtn.addEventListener('click', () => runAction('Check', () => api('/check', {
  method: 'POST',
  json: { fetch: true },
})));

els.deployBtn.addEventListener('click', () => runAction('Deploy', () => api('/deploy', {
  method: 'POST',
  json: { force: false },
})));

els.forceDeployBtn.addEventListener('click', () => {
  if (!confirm('Force deploy will reset the workspace to the configured remote branch. Continue?')) return;
  runAction('Force deploy', () => api('/deploy', {
    method: 'POST',
    json: { force: true },
  }));
});

els.uploadBtn.addEventListener('click', async () => {
  const file = els.zipInput.files?.[0];
  if (!file) {
    toast('Choose a zip file first.');
    return;
  }
  if (!confirm('ZIP upload will apply files to the mounted workspace. Continue?')) return;
  await runAction('ZIP upload', () => api('/upload-zip', {
    method: 'POST',
    headers: {
      ...tokenHeaders(),
      'content-type': 'application/zip',
      'x-file-name': file.name,
    },
    body: file,
  }));
});

document.addEventListener('click', async (event) => {
  const serviceButton = event.target.closest('[data-service-action]');
  if (serviceButton) {
    const action = serviceButton.dataset.serviceAction;
    const service = serviceButton.dataset.service;
    if ((action === 'stop' || action === 'rebuild') && !confirm(`${action} ${service}?`)) return;
    await runAction(`${action} ${service}`, () => api(`/containers/${action}`, {
      method: 'POST',
      json: { services: [service] },
    }));
    await Promise.all([loadServices().catch(() => null), loadContainers().catch(() => null)]);
    return;
  }

  const containerButton = event.target.closest('[data-container-action]');
  if (containerButton) {
    const action = containerButton.dataset.containerAction;
    const container = containerButton.dataset.container;
    if (action === 'stop' && !confirm(`${action} ${container}?`)) return;
    await runAction(`${action} ${container}`, () => api(`/containers/${action}`, {
      method: 'POST',
      json: { containers: [container] },
    }));
    await loadContainers().catch(() => null);
    return;
  }

  const logsButton = event.target.closest('[data-container-logs]');
  if (logsButton) {
    const container = logsButton.dataset.containerLogs;
    await runAction(`logs ${container}`, async () => {
      const result = await api('/containers/logs', {
        method: 'POST',
        json: {
          containers: [container],
          lines: Number(els.logLinesInput.value || 200),
        },
      });
      els.logsBox.textContent = (result.items || [])
        .map((item) => item.logs || '')
        .join('\n');
      return result;
    });
  }
});

renderStatus();
renderServices();
renderContainers();
refreshAll();
