# Resolvy

Assistente de leitura e acessibilidade web com IA, composto por:

- **Backend (Node.js + Express):** guarda as chaves de API (Gemini/OpenAI) criptografadas, gerencia códigos de acesso e expõe a API de análise. Inclui um painel administrativo web.
- **Extensão do Chrome (Manifest V3):** extrai o texto da página ativa, envia ao servidor e mostra a resposta num widget discreto no canto inferior direito. Pode destacar e (com confirmação) clicar em elementos sugeridos pela IA.

## Estrutura

```
resolvy/
├── backend/
│   ├── package.json
│   ├── .env.example            # modelo de configuração
│   ├── src/
│   │   ├── server.js           # Express: API pública + API do painel
│   │   ├── db.js               # SQLite (node:sqlite), criptografia, códigos de acesso
│   │   └── ai.js               # Prompts e chamadas ao Gemini / OpenAI
│   └── public/admin/           # Painel administrativo (HTML/CSS/JS puro)
│       ├── index.html
│       ├── admin.css
│       └── admin.js
└── extension/
    ├── manifest.json
    ├── background.js           # Service worker: única parte que fala com o servidor
    ├── content.js              # Extração de texto, mapeamento de elementos, widget, destaque/clique
    ├── popup/                  # Login com código de acesso + botões de análise
    │   ├── popup.html
    │   ├── popup.css
    │   └── popup.js
    └── icons/
```

## Como funciona

```
 Popup ──(código)──▶ background.js ──POST /api/auth/verify──▶ Servidor
                         │
 Usuário clica "Resumir" │ injeta content.js na aba (activeTab)
                         ▼
 content.js extrai texto + lista de elementos (r0, r1, …)
        │  chrome.runtime.sendMessage
        ▼
 background.js ──POST /api/analyze (Authorization: Bearer <código>)──▶ Servidor ──▶ Gemini/OpenAI
        │                                                                 │
        ◀────────────── { answer, actions: [{element_id, action}] } ◀─────┘
        ▼
 content.js mostra o widget, destaca elementos e oferece "Clicar" (com confirmação)
```

- O **código de acesso nunca chega à página** visitada: só o service worker o conhece.
- A **chave da IA nunca sai do servidor**.
- Os valores digitados pelo usuário em campos de formulário **não são enviados** (apenas os rótulos).
- Se houver texto selecionado na página, só a seleção é analisada.

## 1. Rodando o backend

Requer **Node.js 22.5+** (usa o SQLite nativo do Node, sem compilação).

```bash
cd backend
cp .env.example .env
# edite .env: defina ADMIN_PASSWORD e ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # gera uma ENCRYPTION_KEY
npm install
npm start
```

Abra `http://localhost:3000/admin`, entre com a `ADMIN_PASSWORD` e:

1. Escolha o provedor (Gemini ou OpenAI), o modelo, e cole a chave de API. Salve.
   - Use o provedor **"Teste (sem IA)"** para testar a extensão sem gastar créditos.
2. Em **Códigos de acesso**, gere um código (ex.: `RSV-7KQ2-M9XP-4HTA`). Ele é mostrado **uma única vez** — copie-o. No banco fica só o hash.
3. Na tabela você pode revogar, reativar ou excluir códigos e ver uso.

### API

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| POST | `/api/auth/verify` | — | `{code}` → `{valid, label, expires_at}` |
| POST | `/api/analyze` | `Bearer <código>` | `{text, mode, question?, url, title, elements[]}` → `{answer, actions[]}` |
| GET | `/health` | — | Verificação de saúde |
| * | `/admin/api/*` | cookie de sessão | Login, configurações e códigos |

Modos de `/api/analyze`: `resumo`, `acessibilidade`, `pergunta`.

## 2. Instalando a extensão

1. Abra `chrome://extensions` e ative o **Modo do desenvolvedor**.
2. Clique em **Carregar sem compactação** e selecione a pasta `extension/`.
3. Clique no ícone do Resolvy, abra **Servidor**, informe o endereço (padrão `http://localhost:3000`), cole o código de acesso e clique em **Entrar**.
4. Em qualquer página: **Resumir página**, **Guia de acessibilidade** ou faça uma **pergunta**. Atalho: `Alt+Shift+R` (resumo).

## 3. Conectando as duas partes em produção (HTTPS)

A extensão só aceita `https://` (ou `http://localhost` em desenvolvimento).

1. Publique o `backend/` num serviço com HTTPS (Railway, Render, Fly.io, VPS com Nginx + Let's Encrypt…).
   - Defina as variáveis do `.env` no painel do serviço.
   - Use `TRUST_PROXY=1` quando houver proxy reverso na frente (necessário para o rate limit e cookies `secure`).
   - Garanta um disco persistente para `DATABASE_PATH`.
2. Copie o **ID da extensão** em `chrome://extensions` e coloque em `ALLOWED_EXTENSION_IDS` (o servidor recusa outras origens). Com a variável vazia, qualquer extensão é aceita — use só em desenvolvimento.
3. No popup, informe `https://seu-dominio.com` como servidor.

## Recurso avançado: interação com o DOM

- O `content.js` atribui um id curto (`r0`, `r1`…) a cada elemento interativo visível (links, botões, campos, `role="button"` etc.) e envia a lista com o texto.
- A IA devolve `actions` com `element_id` e `action` (`highlight` ou `click`). O servidor descarta ids inexistentes.
- **Mostrar:** rola até o elemento e aplica um contorno cinza (`data-resolvy-highlight`).
- **Clicar:** exige dois toques ("Clicar" → "Confirmar clique"). Campos de texto recebem apenas foco. O prompt instrui a IA a nunca sugerir cliques em ações destrutivas ou de pagamento.
- `Esc` fecha o widget e remove os destaques.

## Segurança

- Senha do painel comparada em tempo constante; sessão em cookie `httpOnly` + `SameSite=Strict`.
- Rate limit no login do painel, na verificação de códigos e na análise.
- Chaves de API criptografadas com AES-256-GCM (`ENCRYPTION_KEY`); o painel só mostra os 4 últimos caracteres.
- Códigos de acesso armazenados como hash SHA-256, com validade opcional e revogação.
- O texto da página é tratado como dado no prompt (defesa básica contra prompt injection).
