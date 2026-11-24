const $ = (sel) => document.querySelector(sel);
const DEFAULT_SERVER = 'http://localhost:3000';

function show(view) {
  $('#login-view').hidden = view !== 'login';
  $('#main-view').hidden = view !== 'main';
}

async function init() {
  const { serverUrl, accessCode, label } = await chrome.storage.local.get(['serverUrl', 'accessCode', 'label']);
  $('#server').value = serverUrl || DEFAULT_SERVER;
  if (accessCode) {
    $('#who-label').textContent = label ? `como ${label}` : '';
    show('main');
  } else {
    show('login');
    $('#code').focus();
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
    code: $('#code').value,
  });
  $('#login-btn').disabled = false;
  if (!res?.ok) {
    $('#login-msg').textContent = res?.error || 'Falha ao entrar.';
    return;
  }
  $('#code').value = '';
  $('#who-label').textContent = res.label ? `como ${res.label}` : '';
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

init();
