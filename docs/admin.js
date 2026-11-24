const $ = (sel) => document.querySelector(sel);

/* ---------------- Servidor e sessão ---------------- */
// Prioridade: config.js > endereço salvo > mesmo domínio (quando o backend serve o painel localmente).
const CONFIG_URL = (window.RESOLVY_CONFIG?.apiUrl || '').trim();
const store = {
  get(k, s = localStorage) { try { return s.getItem(k); } catch { return null; } },
  set(k, v, s = localStorage) { try { v == null ? s.removeItem(k) : s.setItem(k, v); } catch {} },
};

function normalizeUrl(raw) {
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('Use o endereço HTTPS do Railway.');
  }
  return url.origin;
}

function defaultServer() {
  if (CONFIG_URL) return CONFIG_URL.replace(/\/$/, '');
  const saved = store.get('resolvy_api');
  if (saved) return saved;
  // Servido pelo próprio backend (desenvolvimento local)
  return location.pathname.startsWith('/admin') ? location.origin : '';
}

let apiBase = defaultServer();
let token = store.get('resolvy_token', sessionStorage);

async function api(path, options = {}) {
  if (!apiBase) throw new Error('Informe o endereço do servidor.');
  let res;
  try {
    res = await fetch(`${apiBase}/admin/api${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new Error('Não foi possível conectar ao servidor. Confira o endereço e se o deploy no Railway está ativo.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    setToken(null);
    showLogin();
  }
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

function setToken(t) {
  token = t;
  store.set('resolvy_token', t, sessionStorage);
}

function showLogin() {
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  $('#server-field').hidden = Boolean(CONFIG_URL);
  $('#login-server').value = apiBase;
  ($('#server-field').hidden || apiBase ? $('#login-password') : $('#login-server')).focus();
}

async function showApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  $('#server-label').textContent = apiBase.replace(/^https?:\/\//, '');
  await Promise.all([loadSettings(), loadCodes()]);
}

const fmtDate = (iso) => (iso ? new Date(iso.includes('T') ? iso : `${iso}Z`).toLocaleString('pt-BR') : '—');

/* ---------------- Login ---------------- */
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    if (!CONFIG_URL) {
      apiBase = normalizeUrl($('#login-server').value);
      store.set('resolvy_api', apiBase);
    }
    const { token: t } = await api('/login', { method: 'POST', body: { password: $('#login-password').value } });
    setToken(t);
    $('#login-password').value = '';
    await showApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  setToken(null);
  showLogin();
});

/* ---------------- Configurações ---------------- */
function renderSettings(s) {
  $('#provider').value = s.provider;
  $('#gemini_model').value = s.gemini_model || '';
  $('#openai_model').value = s.openai_model || '';
  $('#gemini_key_hint').textContent = s.gemini_api_key ? `(atual: ${s.gemini_api_key})` : '(não configurada)';
  $('#openai_key_hint').textContent = s.openai_api_key ? `(atual: ${s.openai_api_key})` : '(não configurada)';
  $('#enc-status').textContent = s.encryption_enabled
    ? 'As chaves são armazenadas criptografadas (AES-256-GCM).'
    : 'Atenção: ENCRYPTION_KEY não definida — as chaves estão sendo salvas sem criptografia.';
}

async function loadSettings() {
  renderSettings(await api('/settings'));
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    provider: $('#provider').value,
    gemini_model: $('#gemini_model').value,
    openai_model: $('#openai_model').value,
  };
  for (const k of ['gemini_api_key', 'openai_api_key']) {
    if ($(`#${k}`).value.trim()) body[k] = $(`#${k}`).value.trim();
  }
  try {
    renderSettings(await api('/settings', { method: 'PUT', body }));
    $('#gemini_api_key').value = '';
    $('#openai_api_key').value = '';
    flash('#settings-msg', 'Configurações salvas.');
  } catch (err) {
    flash('#settings-msg', err.message);
  }
});

document.querySelectorAll('[data-clear]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    if (!confirm('Remover esta chave de API?')) return;
    renderSettings(await api('/settings', { method: 'PUT', body: { [btn.dataset.clear]: null } }));
    flash('#settings-msg', 'Chave removida.');
  })
);

function flash(sel, msg) {
  $(sel).textContent = msg;
  setTimeout(() => ($(sel).textContent = ''), 4000);
}

/* ---------------- Códigos de acesso ---------------- */
async function loadCodes() {
  const codes = await api('/codes');
  const body = $('#codes-body');
  body.replaceChildren();
  if (!codes.length) {
    const tr = body.insertRow();
    const td = tr.insertCell();
    td.colSpan = 7;
    td.className = 'muted';
    td.textContent = 'Nenhum código criado ainda.';
    return;
  }
  for (const c of codes) {
    const expired = c.expires_at && new Date(c.expires_at) < new Date();
    const tr = body.insertRow();
    tr.insertCell().textContent = `RSV-…-${c.code_hint}`;
    tr.insertCell().textContent = c.label || '—';

    const status = document.createElement('span');
    status.className = `badge ${c.active && !expired ? 'on' : 'off'}`;
    status.textContent = !c.active ? 'Revogado' : expired ? 'Expirado' : 'Ativo';
    tr.insertCell().append(status);

    tr.insertCell().textContent = c.expires_at ? fmtDate(c.expires_at) : 'Nunca';
    tr.insertCell().textContent = c.usage_count;
    tr.insertCell().textContent = fmtDate(c.last_used_at);

    const actions = document.createElement('div');
    actions.className = 'row';
    const toggle = document.createElement('button');
    toggle.className = 'ghost small';
    toggle.textContent = c.active ? 'Revogar' : 'Reativar';
    toggle.onclick = async () => {
      await api(`/codes/${c.id}`, { method: 'PATCH', body: { active: !c.active } });
      loadCodes();
    };
    const del = document.createElement('button');
    del.className = 'danger small';
    del.textContent = 'Excluir';
    del.onclick = async () => {
      if (!confirm('Excluir este código permanentemente?')) return;
      await api(`/codes/${c.id}`, { method: 'DELETE' });
      loadCodes();
    };
    actions.append(toggle, del);
    tr.insertCell().append(actions);
  }
}

$('#code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const created = await api('/codes', {
    method: 'POST',
    body: { label: $('#code-label').value, expiresInDays: $('#code-days').value || null },
  });
  $('#new-code-value').textContent = created.code;
  $('#new-code').hidden = false;
  $('#code-label').value = '';
  $('#code-days').value = '';
  loadCodes();
});

$('#copy-code').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#new-code-value').textContent);
  $('#copy-code').textContent = 'Copiado!';
  setTimeout(() => ($('#copy-code').textContent = 'Copiar'), 2000);
});

/* ---------------- Início ---------------- */
if (token && apiBase) api('/me').then(showApp).catch(showLogin);
else showLogin();
