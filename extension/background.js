// Service worker da extensão Resolvy.
// Centraliza toda a comunicação com o servidor: o content script nunca vê o código de acesso.

importScripts('config.js');
const DEFAULT_SERVER = RESOLVY_DEFAULT_SERVER;

async function getConfig() {
  const { serverUrl = DEFAULT_SERVER, login = '', key = '' } = await chrome.storage.local.get(['serverUrl', 'login', 'key']);
  return { serverUrl, login, key };
}

/** Exige HTTPS, exceto para localhost (desenvolvimento). */
function normalizeServerUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new Error('Endereço do servidor inválido.');
  }
  const isLocal = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) {
    throw new Error('Use um endereço HTTPS (http só é permitido para localhost).');
  }
  return url.origin;
}

/** Base64 que aceita acentos (UTF-8). */
function toBase64(text) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

async function apiFetch(serverUrl, path, { auth, body } = {}) {
  let res;
  try {
    res = await fetch(`${serverUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: `Basic ${toBase64(`${auth.login}:${auth.key}`)}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw new Error('Não foi possível conectar ao servidor. Verifique o endereço e sua conexão.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Erro ${res.status} no servidor.`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Injeta o content script na aba (se ainda não estiver lá). */
async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch {
    throw new Error('Esta página não permite extensões (ex.: páginas internas do Chrome ou da Web Store).');
  }
}

/** Dispara uma análise na aba. Sem login, mostra o aviso no próprio quadro da página. */
async function runInTab(tabId, mode = 'resumo', question = '') {
  await inject(tabId);
  const { login, key } = await getConfig();
  if (!login || !key) {
    await chrome.tabs.sendMessage(tabId, {
      type: 'resolvy:error',
      message: 'Faça login: clique no ícone do Resolvy na barra do Chrome e entre com seu login e key.',
    });
    return;
  }
  if (mode === 'pergunta' && !question) {
    await chrome.tabs.sendMessage(tabId, { type: 'resolvy:ask' }); // abre a caixa de pergunta no quadro
    return;
  }
  await chrome.tabs.sendMessage(tabId, { type: 'resolvy:run', mode, question });
}

const handlers = {
  // Popup: valida e salva login + key
  async verify({ serverUrl, login, key }) {
    const origin = normalizeServerUrl(serverUrl);
    const cleanLogin = String(login || '').trim().toLowerCase();
    const cleanKey = String(key || '').trim();
    const data = await apiFetch(origin, '/api/auth/verify', { body: { login: cleanLogin, key: cleanKey } });
    await chrome.storage.local.set({ serverUrl: origin, login: data.login, key: cleanKey });
    return { ok: true, login: data.login, expires_at: data.expires_at };
  },

  async logout() {
    await chrome.storage.local.remove(['key']); // mantém o login preenchido
    return { ok: true };
  },

  // Popup: iniciar análise na aba ativa
  async 'analyze-tab'({ tabId, mode, question }) {
    await runInTab(tabId, mode, question);
    return { ok: true };
  },

  // Content script: envia o texto extraído e recebe a resposta da IA
  async 'resolvy:analyze'({ payload }) {
    const { serverUrl, login, key } = await getConfig();
    if (!login || !key) throw new Error('Sessão expirada. Faça login novamente no popup.');
    try {
      const data = await apiFetch(serverUrl, '/api/analyze', { auth: { login, key }, body: payload });
      return { ok: true, data };
    } catch (err) {
      if (err.status === 401) await chrome.storage.local.remove(['key']);
      throw err;
    }
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  // Só páginas da própria extensão (popup) podem logar/disparar análises;
  // content scripts (rodando dentro de sites) só podem pedir a análise do texto.
  const fromExtensionPage = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
  if (!fromExtensionPage && msg.type !== 'resolvy:analyze') return false;
  handler(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // resposta assíncrona
});

// Atalhos de teclado (editáveis em chrome://extensions/shortcuts)
const COMMAND_MODES = {
  'analisar-resumo': 'resumo',
  'analisar-acessibilidade': 'acessibilidade',
  perguntar: 'pergunta',
};

async function handleCommand(command, tab) {
  const mode = COMMAND_MODES[command];
  if (!mode || !tab?.id) return;
  try {
    await runInTab(tab.id, mode);
  } catch (err) {
    // Páginas onde não dá para injetar (chrome://, Web Store): avisa no ícone.
    console.warn('[Resolvy]', err.message);
    chrome.action.setBadgeBackgroundColor({ color: '#b91c1c', tabId: tab.id });
    chrome.action.setBadgeText({ text: '!', tabId: tab.id });
    chrome.action.setTitle({ title: `Resolvy: ${err.message}`, tabId: tab.id });
  }
}

chrome.commands.onCommand.addListener(handleCommand);
