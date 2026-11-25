const $ = (sel) => document.querySelector(sel);
const DEFAULT_SERVER = RESOLVY_DEFAULT_SERVER; // definido em ../config.js

function show(view) {
  $('#login-view').hidden = view !== 'login';
  $('#main-view').hidden = view !== 'main';
}

async function init() {
  const { serverUrl, login, key } = await chrome.storage.local.get(['serverUrl', 'login', 'key']);
  $('#server').value = serverUrl || DEFAULT_SERVER;
  if (login && key) {
    $('#who-label').textContent = `como ${login}`;
    show('main');
  } else {
    show('login');
    if (login) $('#login').value = login;
    $(login ? '#key' : '#login').focus();
  }
}

/* ---------------- Login ---------------- */
$('#login-view').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-msg').textContent = '';
  $('#login-btn').disabled = true;
  const res = await chrome.runtime.sendMessage({
    type: 'verify',
    serverUrl: $('#server').value || DEFAULT_SERVER,
    login: $('#login').value,
    key: $('#key').value,
  });
  $('#login-btn').disabled = false;
  if (!res?.ok) {
    $('#login-msg').textContent = res?.error || 'Falha ao entrar.';
    return;
  }
  $('#key').value = '';
  $('#who-label').textContent = `como ${res.login}`;
  show('main');
});

$('#logout').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'logout' });
  show('login');
});

/* ---------------- Análise ---------------- */
async function analyze(mode, question = '') {
  $('#main-msg').textContent = '';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const res = await chrome.runtime.sendMessage({ type: 'analyze-tab', tabId: tab.id, mode, question });
  if (!res?.ok) {
    $('#main-msg').textContent = res?.error || 'Não foi possível analisar esta página.';
    return;
  }
  window.close(); // a resposta aparece no widget dentro da página
}

document.querySelectorAll('[data-mode]').forEach((btn) =>
  btn.addEventListener('click', () => analyze(btn.dataset.mode))
);

$('#ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#question').value.trim();
  if (!q) return $('#question').focus();
  analyze('pergunta', q);
});

/* ---------------- Atalhos ---------------- */
// O Chrome não deixa a extensão mudar as teclas por código: a troca é feita
// na página chrome://extensions/shortcuts, que o botão abaixo abre.
async function loadShortcuts() {
  const list = $('#shortcut-list');
  list.replaceChildren();
  const order = ['analisar-resumo', 'analisar-acessibilidade', 'perguntar', '_execute_action'];
  const commands = (await chrome.commands.getAll())
    .filter((c) => c.name !== '_execute_action' || c.shortcut)
    .sort((x, y) => order.indexOf(x.name) - order.indexOf(y.name));
  for (const c of commands) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = c.name === '_execute_action' ? 'Abrir este menu' : c.description;
    const kbd = document.createElement('kbd');
    kbd.textContent = c.shortcut || 'não definido';
    if (!c.shortcut) kbd.classList.add('none');
    li.append(name, kbd);
    list.append(li);
  }
}

$('#edit-shortcuts').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  window.close();
});

init();
loadShortcuts();
