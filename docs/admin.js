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
  await Promise.all([loadSettings(), loadUsers()]);
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

/* ---------------- Usuários (login + key) ---------------- */
async function copyText(btn, text) {
  try { await navigator.clipboard.writeText(text); } catch { prompt('Copie:', text); return; }
  const old = btn.textContent;
  btn.textContent = 'Copiado!';
  setTimeout(() => (btn.textContent = old), 1500);
}

function smallButton(text, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `${cls} small`;
  b.textContent = text;
  b.onclick = onClick;
  return b;
}

function showNewUser(login, key) {
  $('#new-user-value').textContent = `Login: ${login}   Key: ${key}`;
  $('#new-user').hidden = false;
}

async function loadUsers() {
  const users = await api('/users');
  const body = $('#users-body');
  body.replaceChildren();
  if (!users.length) {
    const td = body.insertRow().insertCell();
    td.colSpan = 7;
    td.className = 'muted';
    td.textContent = 'Nenhum usuário criado ainda.';
    return;
  }
  for (const u of users) {
    const expired = u.expires_at && new Date(u.expires_at) < new Date();
    const tr = body.insertRow();

    const loginCell = tr.insertCell();
    const strong = document.createElement('strong');
    strong.textContent = u.login;
    loginCell.append(strong);

    // Key: oculta, com "Ver" e "Copiar"
    const keyCell = tr.insertCell();
    const keyWrap = document.createElement('div');
    keyWrap.className = 'row';
    const keyText = document.createElement('code');
    keyText.className = 'key';
    keyText.textContent = '••••••';
    let revealed = null;
    const fetchKey = async () => (revealed ??= (await api(`/users/${u.id}/key`)).key);
    keyWrap.append(
      keyText,
      smallButton('Ver', 'ghost', async (e) => {
        const showing = e.target.textContent === 'Ocultar';
        keyText.textContent = showing ? '••••••' : await fetchKey();
        e.target.textContent = showing ? 'Ver' : 'Ocultar';
      }),
      smallButton('Copiar', 'ghost', async (e) => copyText(e.target, `Login: ${u.login}   Key: ${await fetchKey()}`))
    );
    keyCell.append(keyWrap);

    const status = document.createElement('span');
    status.className = `badge ${u.active && !expired ? 'on' : 'off'}`;
    status.textContent = !u.active ? 'Desativado' : expired ? 'Expirado' : 'Ativo';
    tr.insertCell().append(status);

    tr.insertCell().textContent = u.expires_at ? fmtDate(u.expires_at) : 'Nunca';
    tr.insertCell().textContent = u.usage_count;
    tr.insertCell().textContent = fmtDate(u.last_used_at);

    const actions = document.createElement('div');
    actions.className = 'row';
    actions.append(
      smallButton('Trocar key', 'ghost', async () => {
        const novo = prompt(`Nova key para "${u.login}" (deixe vazio para gerar uma automática):`, '');
        if (novo === null) return;
        try {
          const { key } = await api(`/users/${u.id}`, { method: 'PATCH', body: { key: novo } });
          showNewUser(u.login, key);
          loadUsers();
        } catch (err) { alert(err.message); }
      }),
      smallButton(u.active ? 'Desativar' : 'Ativar', 'ghost', async () => {
        await api(`/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } });
        loadUsers();
      }),
      smallButton('Excluir', 'danger', async () => {
        if (!confirm(`Excluir o usuário "${u.login}"?`)) return;
        await api(`/users/${u.id}`, { method: 'DELETE' });
        loadUsers();
      })
    );
    tr.insertCell().append(actions);
  }
}

$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#user-error').textContent = '';
  try {
    const created = await api('/users', {
      method: 'POST',
      body: {
        login: $('#user-login').value,
        key: $('#user-key').value,
        expiresInDays: $('#user-days').value || null,
      },
    });
    showNewUser(created.login, created.key);
    e.target.reset();
    loadUsers();
  } catch (err) {
    $('#user-error').textContent = err.message;
  }
});

$('#copy-user').addEventListener('click', (e) => copyText(e.target, $('#new-user-value').textContent));

/* ---------------- Início ---------------- */
if (token && apiBase) api('/me').then(showApp).catch(showLogin);
else showLogin();
