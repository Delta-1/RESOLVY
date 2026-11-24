// Service worker da extensão Resolvy.
// Centraliza toda a comunicação com o servidor: o content script nunca vê o código de acesso.

importScripts('config.js');
const DEFAULT_SERVER = RESOLVY_DEFAULT_SERVER;

async function getConfig() {
  const { serverUrl = DEFAULT_SERVER, accessCode = '' } = await chrome.storage.local.get(['serverUrl', 'accessCode']);
  return { serverUrl, accessCode };
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

async function apiFetch(serverUrl, path, { code, body } = {}) {
  let res;
  try {
    res = await fetch(`${serverUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(code ? { Authorization: `Bearer ${code}` } : {}),
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

/** Injeta o content script (se ainda não estiver na aba) e dispara a análise. */
async function runInTab(tabId, mode = 'resumo', question = '') {
  const { accessCode } = await getConfig();
  if (!accessCode) throw new Error('Faça login no popup da extensão com seu código de acesso.');
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch {
    throw new Error('Esta página não permite extensões (ex.: páginas internas do Chrome ou da Web Store).');
  }
  await chrome.tabs.sendMessage(tabId, { type: 'resolvy:run', mode, question });
}

const handlers = {
  // Popup: valida e salva o código de acesso
  async verify({ serverUrl, code }) {
    const origin = normalizeServerUrl(serverUrl);
    const cleanCode = String(code || '').trim().toUpperCase();
    const data = await apiFetch(origin, '/api/auth/verify', { body: { code: cleanCode } });
    await chrome.storage.local.set({ serverUrl: origin, accessCode: cleanCode, label: data.label || '' });
    return { ok: true, label: data.label, expires_at: data.expires_at };
  },

  async logout() {
    await chrome.storage.local.remove(['accessCode', 'label']);
    return { ok: true };
  },

  // Popup: iniciar análise na aba ativa
  async 'analyze-tab'({ tabId, mode, question }) {
    await runInTab(tabId, mode, question);
    return { ok: true };
  },

  // Content script: envia o texto extraído e recebe a resposta da IA
  async 'resolvy:analyze'({ payload }) {
    const { serverUrl, accessCode } = await getConfig();
    if (!accessCode) throw new Error('Sessão expirada. Faça login novamente no popup.');
    try {
      const data = await apiFetch(serverUrl, '/api/analyze', { code: accessCode, body: payload });
      return { ok: true, data };
    } catch (err) {
      if (err.status === 401) await chrome.storage.local.remove(['accessCode', 'label']);
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

// Atalho de teclado (Alt+Shift+R)
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'analyze-page' || !tab?.id) return;
  try {
    await runInTab(tab.id, 'resumo');
  } catch (err) {
    console.warn('[Resolvy]', err.message);
  }
});
