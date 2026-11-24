# Resolvy

Assistente de leitura e acessibilidade web com IA, em três partes:

| Parte | Onde roda | Pasta |
|---|---|---|
| **API** (Node.js + Express + SQLite) | Railway | `backend/` |
| **Painel administrativo** (HTML estático) | GitHub Pages | `docs/` |
| **Extensão do Chrome** (Manifest V3) | Navegador de cada usuário | `extension/` |

```
 GitHub Pages (docs/)                Railway (backend/)                    Gemini / OpenAI
 ┌──────────────────┐  HTTPS+token  ┌───────────────────────┐   chave da API  ┌──────────┐
 │ Painel admin     │ ────────────▶ │ /admin/api/*          │ ──────────────▶ │    IA    │
 └──────────────────┘               │ /api/auth/verify      │                 └──────────┘
 ┌──────────────────┐ HTTPS+código  │ /api/analyze          │
 │ Extensão Chrome  │ ────────────▶ │ SQLite no Volume      │
 └──────────────────┘               └───────────────────────┘
```

## Estrutura

```
resolvy/
├── backend/                    # → Railway (Root Directory = backend)
│   ├── railway.json            # build Railpack, healthcheck /health
│   ├── .node-version           # Node 22
│   ├── .env.example            # variáveis de ambiente documentadas
│   ├── package.json
│   └── src/
│       ├── server.js           # rotas, CORS, autenticação
│       ├── db.js               # SQLite, criptografia, códigos, sessões do painel
│       └── ai.js               # prompts e chamadas ao Gemini / OpenAI
├── docs/                       # → GitHub Pages (pasta /docs)
│   ├── index.html              # painel administrativo
│   ├── config.js               # ← coloque aqui a URL do Railway
│   ├── admin.js
│   └── admin.css
└── extension/                  # → chrome://extensions (Carregar sem compactação)
    ├── config.js               # ← coloque aqui a URL do Railway
    ├── manifest.json
    ├── background.js           # única parte que conversa com o servidor
    ├── content.js              # extração de texto, widget, destaque/clique
    ├── popup/
    └── icons/
```

---

## Deploy passo a passo

### 1. Backend no Railway

1. Em [railway.com](https://railway.com): **New Project → Deploy from GitHub repo →** `Delta-1/RESOLVY`.
2. No serviço criado, abra **Settings**:
   - **Source → Root Directory:** `backend`
   - **Source → Branch:** o branch que contém este código.
   - **Networking → Generate Domain** — gera algo como `https://resolvy-production.up.railway.app`.
3. **Adicione um Volume** (clique com o botão direito no serviço → *Attach Volume*, ou `Ctrl/⌘ + K` → *Volume*). Mount path: `/data`.
   O servidor detecta o volume sozinho (`RAILWAY_VOLUME_MOUNT_PATH`) e salva o banco em `/data/resolvy.db`.
   **Sem volume, códigos e chaves são apagados a cada deploy.**
4. Em **Variables**, cadastre:

   | Variável | Valor |
   |---|---|
   | `ADMIN_PASSWORD` | senha forte do painel (obrigatória) |
   | `ENCRYPTION_KEY` | gere com `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` — não troque depois |
   | `ADMIN_ORIGINS` | `https://delta-1.github.io` (origem do GitHub Pages, sem caminho) |
   | `ALLOWED_EXTENSION_IDS` | deixe vazio por enquanto; preencha no passo 4 |

5. Aguarde o deploy e teste: `https://SEU-APP.up.railway.app/health` deve responder `{"ok":true}`.
   Os logs de início mostram o caminho do banco e as origens permitidas.

O `railway.json` já configura o build (Railpack), o comando `npm start`, o healthcheck e o reinício automático. `PORT` e o proxy HTTPS são detectados automaticamente.

### 2. Painel no GitHub Pages

1. Edite `docs/config.js` e coloque a URL do Railway:
   ```js
   window.RESOLVY_CONFIG = { apiUrl: 'https://resolvy-production.up.railway.app' };
   ```
   (Se deixar vazio, o painel pede o endereço na tela de login.)
2. Faça commit e push.
3. No GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch →** escolha o branch e a pasta **`/docs`** → *Save*.
4. Em ~1 minuto o painel estará em `https://delta-1.github.io/RESOLVY/`.
5. Entre com a `ADMIN_PASSWORD`, escolha o provedor (Gemini/OpenAI), cole a chave da API e gere os códigos de acesso.

> O painel usa um token de sessão (válido por 8 h, guardado só na aba) em vez de cookies, porque o GitHub Pages e o Railway são domínios diferentes. O painel é público, mas não contém nenhum segredo: tudo exige a senha.

### 3. Extensão

1. Edite `extension/config.js`:
   ```js
   const RESOLVY_DEFAULT_SERVER = 'https://resolvy-production.up.railway.app';
   ```
2. `chrome://extensions` → ative **Modo do desenvolvedor** → **Carregar sem compactação** → pasta `extension/`.
3. Clique no ícone do Resolvy, cole um código de acesso e **Entrar**.

Para distribuir a outras pessoas: compacte a pasta `extension/` em `.zip` (ou publique na Chrome Web Store, o que mantém o mesmo ID para todos).

### 4. Fechar a API só para a sua extensão (recomendado)

1. Copie o **ID** da extensão em `chrome://extensions`.
2. No Railway, defina `ALLOWED_EXTENSION_IDS=<id>` (vários separados por vírgula).

O ID de uma extensão carregada sem compactação muda se a pasta mudar de lugar; o da Web Store é fixo.

---

## Desenvolvimento local

```bash
cd backend
cp .env.example .env      # defina ADMIN_PASSWORD e ENCRYPTION_KEY
npm install
npm start                 # http://localhost:3000/admin serve o painel de ../docs
```

Com `docs/config.js` vazio, o painel local usa o próprio servidor. A extensão usa `http://localhost:3000` por padrão. Use o provedor **"Teste (sem IA)"** para testar sem gastar créditos.

## API

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/health` | — | Healthcheck |
| POST | `/api/auth/verify` | — | `{code}` → `{valid, label, expires_at}` |
| POST | `/api/analyze` | `Bearer <código de acesso>` | `{text, mode, question?, url, title, elements[]}` → `{answer, actions[]}` |
| POST | `/admin/api/login` | — | `{password}` → `{token}` |
| GET/PUT | `/admin/api/settings` | `Bearer <token>` | Provedor, modelos e chaves (mascaradas) |
| GET/POST | `/admin/api/codes` | `Bearer <token>` | Listar / criar códigos |
| PATCH/DELETE | `/admin/api/codes/:id` | `Bearer <token>` | Revogar/reativar / excluir |

Modos de `/api/analyze`: `resumo`, `acessibilidade`, `pergunta`.

## Interação com o DOM

- O `content.js` atribui ids curtos (`r0`, `r1`…) aos elementos interativos visíveis e envia a lista junto com o texto.
- A IA devolve `actions` com `element_id` e `action` (`highlight` ou `click`); o servidor descarta ids inexistentes.
- **Mostrar:** rola até o elemento e aplica um contorno cinza.
- **Clicar:** exige dois toques ("Clicar" → "Confirmar clique"). Campos de texto recebem apenas foco.
- `Esc` fecha o widget e remove os destaques.

## Segurança

- Senha do painel comparada em tempo constante; sessões com token aleatório (só o hash fica no banco).
- CORS: painel só a partir de `ADMIN_ORIGINS`; API só a partir de `chrome-extension://` (e dos IDs em `ALLOWED_EXTENSION_IDS`).
- Rate limit no login, na verificação de códigos e na análise (com o IP real atrás do proxy do Railway).
- Chaves de API criptografadas com AES-256-GCM; o painel só mostra os 4 últimos caracteres.
- Códigos de acesso armazenados como hash SHA-256, com validade e revogação.
- Valores digitados em formulários nunca são enviados; o texto da página é tratado como dado no prompt.
