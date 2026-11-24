// Content script do Resolvy.
// Injetado sob demanda (activeTab) quando o usuário pede uma análise.
// Responsabilidades: extrair texto, mapear elementos interativos, exibir o widget e destacar/clicar elementos.

(() => {
  if (window.__resolvyLoaded) return; // evita dupla injeção
  window.__resolvyLoaded = true;

  const MAX_TEXT = 15000;
  const MAX_ELEMENTS = 150;
  const HOST_ID = 'resolvy-widget-host';

  const MODE_LABELS = {
    resumo: 'Resumo da página',
    acessibilidade: 'Guia de acessibilidade',
    pergunta: 'Resposta',
  };

  /* ================================================================ */
  /* 1. Extração de texto                                             */
  /* ================================================================ */

  const TEXT_SELECTOR = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'li', 'dt', 'dd', 'blockquote', 'pre',
    'figcaption', 'caption', 'summary', 'label',
    'td', 'th', '[role="heading"]', '[role="listitem"]',
  ].join(',');

  const SKIP_ANCESTORS = 'script, style, noscript, template, svg, [aria-hidden="true"], [hidden], #' + HOST_ID;

  function isVisible(el) {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  }

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function formatBlock(el, text) {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag) || el.getAttribute('role') === 'heading') return `\n## ${text}`;
    if (tag === 'li' || el.getAttribute('role') === 'listitem') return `- ${text}`;
    if (tag === 'dt') return `**${text}**`;
    if (tag === 'blockquote') return `> ${text}`;
    if (tag === 'td' || tag === 'th') return `| ${text}`;
    return text;
  }

  /** Escolhe a área principal da página (main/article) se ela tiver conteúdo suficiente. */
  function pickRoot() {
    const candidates = document.querySelectorAll('main, [role="main"], article');
    for (const c of candidates) {
      if (isVisible(c) && clean(c.innerText).length > 300) return c;
    }
    return document.body;
  }

  function extractText() {
    // Se o usuário selecionou um trecho, analisamos apenas a seleção.
    const selection = clean(window.getSelection()?.toString());
    if (selection.length >= 20) return { text: selection.slice(0, MAX_TEXT), source: 'seleção' };

    const root = pickRoot();
    const accepted = new Set();
    const lines = [];
    let total = 0;

    for (const el of root.querySelectorAll(TEXT_SELECTOR)) {
      if (total >= MAX_TEXT) break;
      if (el.closest(SKIP_ANCESTORS) || !isVisible(el)) continue;

      // Pula elementos cujo ancestor de texto já foi capturado (ex.: <p> dentro de <li>)
      let parent = el.parentElement;
      let nested = false;
      while (parent && parent !== root) {
        if (accepted.has(parent)) { nested = true; break; }
        parent = parent.parentElement;
      }
      if (nested) continue;

      const text = clean(el.innerText);
      if (text.length < 2) continue;
      accepted.add(el);
      const line = formatBlock(el, text);
      lines.push(line);
      total += line.length + 1;
    }

    let text = lines.join('\n').trim();
    // Fallback para páginas que usam apenas <div>/<span>
    if (text.length < 200) text = clean(root.innerText);
    return { text: text.slice(0, MAX_TEXT), source: root === document.body ? 'página' : 'conteúdo principal' };
  }

  /* ================================================================ */
  /* 2. Mapeamento de elementos interativos                           */
  /* ================================================================ */

  const INTERACTIVE_SELECTOR = [
    'a[href]', 'button', 'summary', 'select', 'textarea',
    'input:not([type="hidden"])',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="option"]',
  ].join(',');

  /** id curto (r0, r1...) -> elemento real. Recriado a cada análise. */
  let elementMap = new Map();

  function accessibleLabel(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
      if (clean(t)) return t;
    }
    if (el.labels?.length) return el.labels[0].innerText;
    const tag = el.tagName.toLowerCase();
    // Para campos de texto, nunca enviamos o valor digitado pelo usuário, só o rótulo.
    if (tag === 'input' && ['submit', 'button', 'reset'].includes(el.type)) return el.value;
    if (tag === 'input' || tag === 'textarea') return el.placeholder || el.title || el.name;
    if (tag === 'select') return el.title || el.name;
    return el.innerText || el.title || el.querySelector('img[alt]')?.alt || '';
  }

  function collectElements() {
    document.querySelectorAll('[data-resolvy-id]').forEach((el) => el.removeAttribute('data-resolvy-id'));
    elementMap = new Map();
    const list = [];
    let i = 0;

    for (const el of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
      if (list.length >= MAX_ELEMENTS) break;
      if (el.closest(SKIP_ANCESTORS) || el.disabled || !isVisible(el)) continue;
      const label = clean(accessibleLabel(el)).slice(0, 120);
      if (!label) continue;

      const id = `r${i++}`;
      el.setAttribute('data-resolvy-id', id);
      elementMap.set(id, el);
      list.push({
        id,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || el.getAttribute('role') || '',
        label,
      });
    }
    return list;
  }

  /* ================================================================ */
  /* 3. Destaque e clique                                             */
  /* ================================================================ */

  function ensureHighlightStyle() {
    if (document.getElementById('resolvy-highlight-style')) return;
    const style = document.createElement('style');
    style.id = 'resolvy-highlight-style';
    style.textContent = `
      [data-resolvy-highlight] {
        outline: 3px solid #475569 !important;
        outline-offset: 3px !important;
        box-shadow: 0 0 0 6px rgba(100, 116, 139, 0.35) !important;
        border-radius: 4px;
        transition: outline-color .2s, box-shadow .2s;
      }`;
    document.documentElement.appendChild(style);
  }

  function clearHighlights() {
    document.querySelectorAll('[data-resolvy-highlight]').forEach((el) => el.removeAttribute('data-resolvy-highlight'));
  }

  function highlightElement(id) {
    const el = elementMap.get(id);
    if (!el || !el.isConnected) return false;
    ensureHighlightStyle();
    clearHighlights();
    el.setAttribute('data-resolvy-highlight', '');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
  }

  function simulateClick(id) {
    const el = elementMap.get(id);
    if (!el || !el.isConnected) return false;
    highlightElement(id);
    const tag = el.tagName.toLowerCase();
    const textLike = (tag === 'input' && !['checkbox', 'radio', 'submit', 'button', 'reset'].includes(el.type)) ||
      tag === 'textarea' || tag === 'select';
    el.focus({ preventScroll: true });
    if (textLike) return true; // para campos, apenas focar

    const opts = { bubbles: true, cancelable: true, composed: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
    return true;
  }

  /* ================================================================ */
  /* 4. Widget flutuante (Shadow DOM, isolado do CSS da página)        */
  /* ================================================================ */

  const WIDGET_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel {
      --bg: #f8fafc; --surface: #ffffff; --border: #cbd5e1; --text: #1e293b;
      --muted: #64748b; --accent: #475569; --accent-hover: #334155; --error: #b91c1c;
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      width: min(340px, calc(100vw - 32px)); max-height: min(60vh, 520px);
      display: flex; flex-direction: column;
      background: var(--bg); color: var(--text); border: 1px solid var(--border);
      border-radius: 12px; box-shadow: 0 8px 24px rgba(15, 23, 42, .18);
      font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      overflow: hidden;
    }
    @media (prefers-color-scheme: dark) {
      .panel {
        --bg: #1e293b; --surface: #0f172a; --border: #334155; --text: #e2e8f0;
        --muted: #94a3b8; --accent: #64748b; --accent-hover: #94a3b8; --error: #fca5a5;
      }
    }
    header {
      display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 14px;
      border-bottom: 1px solid var(--border); background: var(--surface);
    }
    header .title { flex: 1; font-weight: 600; font-size: 13px; }
    header .title small { display: block; font-weight: 400; color: var(--muted); font-size: 11px; }
    .icon-btn {
      all: unset; cursor: pointer; width: 26px; height: 26px; display: grid; place-items: center;
      border-radius: 6px; color: var(--muted); font-size: 16px;
    }
    .icon-btn:hover, .icon-btn:focus-visible { background: var(--border); color: var(--text); }
    .body { padding: 12px 14px; overflow-y: auto; }
    .answer { white-space: pre-wrap; word-wrap: break-word; margin: 0; }
    .error { color: var(--error); }
    .loading { color: var(--muted); display: flex; gap: 8px; align-items: center; }
    .spinner {
      width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent);
      border-radius: 50%; animation: spin .8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .actions { margin-top: 12px; display: grid; gap: 8px; }
    .actions h3 { margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
    .action {
      border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--surface);
    }
    .action .label { font-weight: 600; font-size: 13px; }
    .action .reason { color: var(--muted); font-size: 12px; margin: 2px 0 6px; }
    .action .btns { display: flex; gap: 6px; }
    .btn {
      all: unset; cursor: pointer; font-size: 12px; padding: 3px 10px; border-radius: 6px;
      border: 1px solid var(--accent); color: var(--text);
    }
    .btn:hover, .btn:focus-visible { background: var(--accent); color: #fff; }
    .btn.primary { background: var(--accent); color: #fff; }
    .btn.primary:hover { background: var(--accent-hover); }
    .btn.confirm, .btn.confirm:hover { background: #b45309; border-color: #b45309; color: #fff; }
    .btn:disabled { opacity: .7; cursor: default; }
    footer { padding: 6px 14px; font-size: 11px; color: var(--muted); border-top: 1px solid var(--border); }
    .panel.min { width: auto; }
    .panel.min .body, .panel.min footer { display: none; }
    .panel.min header { border-bottom: 0; }
  `;

  let host, shadow, panel, bodyEl;

  function ensureWidget() {
    if (host?.isConnected) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>${WIDGET_CSS}</style>
      <section class="panel" role="dialog" aria-label="Resolvy">
        <header>
          <div class="title">Resolvy <small class="subtitle"></small></div>
          <button class="icon-btn" data-act="min" title="Minimizar" aria-label="Minimizar">–</button>
          <button class="icon-btn" data-act="close" title="Fechar (Esc)" aria-label="Fechar">×</button>
        </header>
        <div class="body" aria-live="polite"></div>
        <footer>Esc fecha · Alt+Shift+R resume a página</footer>
      </section>`;
    panel = shadow.querySelector('.panel');
    bodyEl = shadow.querySelector('.body');
    shadow.querySelector('[data-act="min"]').addEventListener('click', toggleMinimize);
    shadow.querySelector('[data-act="close"]').addEventListener('click', closeWidget);
    document.documentElement.appendChild(host);
  }

  function toggleMinimize() {
    const min = panel.classList.toggle('min');
    const btn = shadow.querySelector('[data-act="min"]');
    btn.textContent = min ? '▢' : '–';
    btn.setAttribute('aria-label', min ? 'Expandir' : 'Minimizar');
  }

  function closeWidget() {
    clearHighlights();
    host?.remove();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && host?.isConnected) closeWidget();
  });

  function setSubtitle(text) {
    shadow.querySelector('.subtitle').textContent = text;
  }

  function renderLoading(mode) {
    ensureWidget();
    panel.classList.remove('min');
    setSubtitle(MODE_LABELS[mode] || '');
    bodyEl.replaceChildren();
    const div = document.createElement('div');
    div.className = 'loading';
    div.innerHTML = '<span class="spinner"></span>';
    div.append('Analisando a página…');
    bodyEl.append(div);
  }

  function renderError(message) {
    ensureWidget();
    bodyEl.replaceChildren();
    const p = document.createElement('p');
    p.className = 'answer error';
    p.textContent = message;
    bodyEl.append(p);
  }

  function renderResult(data, source) {
    ensureWidget();
    bodyEl.replaceChildren();

    const p = document.createElement('p');
    p.className = 'answer';
    p.textContent = data.answer || '(sem resposta)';
    bodyEl.append(p);

    const actions = (data.actions || []).filter((a) => elementMap.has(a.element_id));
    if (actions.length) {
      const wrap = document.createElement('div');
      wrap.className = 'actions';
      const h = document.createElement('h3');
      h.textContent = 'Elementos sugeridos';
      wrap.append(h);
      actions.forEach((a) => wrap.append(renderAction(a)));
      bodyEl.append(wrap);

      // Destaca automaticamente o primeiro elemento sugerido
      highlightElement(actions[0].element_id);
    }
    setSubtitle(`${shadow.querySelector('.subtitle').textContent} · ${source}`);
  }

  function renderAction(action) {
    const el = elementMap.get(action.element_id);
    const card = document.createElement('div');
    card.className = 'action';

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = clean(accessibleLabel(el)).slice(0, 80) || el.tagName.toLowerCase();
    const reason = document.createElement('div');
    reason.className = 'reason';
    reason.textContent = action.reason;

    const btns = document.createElement('div');
    btns.className = 'btns';

    const show = document.createElement('button');
    show.className = 'btn';
    show.textContent = 'Mostrar';
    show.addEventListener('click', () => highlightElement(action.element_id));
    btns.append(show);

    if (action.action === 'click') {
      // Clique em duas etapas: o usuário sempre confirma.
      const click = document.createElement('button');
      click.className = 'btn primary';
      click.textContent = 'Clicar';
      let armed = false;
      let timer;
      click.addEventListener('click', () => {
        if (!armed) {
          armed = true;
          highlightElement(action.element_id);
          click.textContent = 'Confirmar clique';
          click.classList.add('confirm');
          timer = setTimeout(() => {
            armed = false;
            click.textContent = 'Clicar';
            click.classList.remove('confirm');
          }, 4000);
          return;
        }
        clearTimeout(timer);
        simulateClick(action.element_id);
        click.textContent = 'Clicado ✓';
        click.disabled = true;
      });
      btns.append(click);
    }

    card.append(label, reason, btns);
    return card;
  }

  /* ================================================================ */
  /* 5. Fluxo principal                                               */
  /* ================================================================ */

  async function run(mode, question) {
    renderLoading(mode);
    const { text, source } = extractText();
    if (text.length < 20) {
      renderError('Não encontrei texto suficiente nesta página para analisar.');
      return;
    }
    const elements = collectElements();

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'resolvy:analyze',
        payload: { mode, question, text, elements, url: location.href, title: document.title },
      });
    } catch {
      renderError('A extensão foi atualizada. Recarregue a página e tente novamente.');
      return;
    }
    if (!response?.ok) {
      renderError(response?.error || 'Erro desconhecido.');
      return;
    }
    renderResult(response.data, source);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'resolvy:run') run(msg.mode || 'resumo', msg.question || '');
  });
})();
