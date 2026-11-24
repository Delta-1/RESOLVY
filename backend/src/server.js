import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  dbPath,
  getPublicSettings,
  setSetting,
  createAccessCode,
  listAccessCodes,
  setAccessCodeActive,
  deleteAccessCode,
  validateAccessCode,
  createAdminSession,
  isValidAdminSession,
  deleteAdminSession,
} from './db.js';
import { analyze, MODES } from './ai.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MAX_TEXT_CHARS = Number(process.env.MAX_TEXT_CHARS || 15000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ON_RAILWAY = Boolean(process.env.RAILWAY_ENVIRONMENT);

if (!ADMIN_PASSWORD) {
  console.error('❌ Defina a variável ADMIN_PASSWORD (no .env ou nas Variables do Railway).');
  process.exit(1);
}
if (ADMIN_PASSWORD.length < 10) console.warn('⚠️  ADMIN_PASSWORD curta: use pelo menos 10 caracteres.');
if (!process.env.ENCRYPTION_KEY) {
  console.warn('⚠️  ENCRYPTION_KEY não definida: as chaves de API serão salvas sem criptografia.');
}

const csv = (v) => (v || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
const allowedExtensionIds = csv(process.env.ALLOWED_EXTENSION_IDS);
const adminOrigins = csv(process.env.ADMIN_ORIGINS); // ex.: https://delta-1.github.io

const app = express();
// O Railway (e a maioria das hospedagens) fica atrás de um proxy HTTPS.
if (process.env.TRUST_PROXY === '1' || (ON_RAILWAY && process.env.TRUST_PROXY !== '0')) app.set('trust proxy', 1);

// A API é consumida por outra origem (GitHub Pages e a extensão).
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '300kb' }));

/* ------------------------------------------------------------------ */
/* CORS                                                                 */
/* ------------------------------------------------------------------ */
function cors(isAllowed) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      if (!isAllowed(origin)) return res.status(403).json({ error: `Origem não autorizada: ${origin}` });
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}

// API da extensão: somente chrome-extension://<id>
app.use(
  '/api',
  cors((origin) => {
    if (!origin.startsWith('chrome-extension://')) return false;
    if (allowedExtensionIds.length === 0) return true; // desenvolvimento
    return allowedExtensionIds.includes(origin.slice('chrome-extension://'.length));
  })
);

// API do painel: origens do GitHub Pages (ADMIN_ORIGINS) + localhost.
// A autenticação é por token Bearer (sem cookies), então não há risco de CSRF.
app.use(
  '/admin/api',
  cors((origin) => {
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
    if (adminOrigins.length === 0) return true; // sem restrição configurada
    return adminOrigins.includes(origin);
  })
);

/* ------------------------------------------------------------------ */
/* API pública (usada pela extensão)                                    */
/* ------------------------------------------------------------------ */
const limiter = (windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false });
const apiLimiter = limiter(60_000, 30);
const verifyLimiter = limiter(15 * 60_000, 20);
const loginLimiter = limiter(15 * 60_000, 10);

function readBearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

function requireAccessCode(req, res, next) {
  const record = validateAccessCode(readBearer(req), { countUsage: true });
  if (!record) return res.status(401).json({ error: 'Código de acesso inválido, expirado ou revogado.' });
  req.accessCode = record;
  next();
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/auth/verify', verifyLimiter, (req, res) => {
  const record = validateAccessCode(req.body?.code);
  if (!record) return res.status(401).json({ valid: false, error: 'Código inválido, expirado ou revogado.' });
  res.json({ valid: true, label: record.label, expires_at: record.expires_at });
});

app.post('/api/analyze', apiLimiter, requireAccessCode, async (req, res) => {
  const { text, url, title, mode = 'resumo', question = '', elements = [] } = req.body || {};

  if (typeof text !== 'string' || text.trim().length < 20) {
    return res.status(400).json({ error: 'Texto insuficiente para análise.' });
  }
  if (!Object.hasOwn(MODES, mode)) return res.status(400).json({ error: 'Modo inválido.' });
  if (mode === 'pergunta' && !String(question).trim()) {
    return res.status(400).json({ error: 'Escreva uma pergunta.' });
  }

  const safeElements = (Array.isArray(elements) ? elements : [])
    .slice(0, 150)
    .filter((e) => e && typeof e.id === 'string' && /^r\d{1,5}$/.test(e.id))
    .map((e) => ({
      id: e.id,
      tag: String(e.tag || '').slice(0, 20),
      type: e.type ? String(e.type).slice(0, 20) : '',
      label: String(e.label || '').replace(/\s+/g, ' ').slice(0, 120),
    }));

  try {
    const result = await analyze({
      mode,
      question: String(question).slice(0, 500),
      url: String(url || '').slice(0, 500),
      title: String(title || '').slice(0, 300),
      text: text.slice(0, MAX_TEXT_CHARS),
      elements: safeElements,
    });
    res.json(result);
  } catch (err) {
    console.error('[analyze]', err.message);
    res.status(502).json({ error: err.message || 'Falha ao consultar a IA.' });
  }
});

/* ------------------------------------------------------------------ */
/* API do painel administrativo                                         */
/* ------------------------------------------------------------------ */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireAdmin(req, res, next) {
  if (!isValidAdminSession(readBearer(req))) return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
  next();
}

app.post('/admin/api/login', loginLimiter, (req, res) => {
  if (!safeEqual(req.body?.password ?? '', ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }
  res.json({ token: createAdminSession(SESSION_TTL_MS), expires_in: SESSION_TTL_MS / 1000 });
});

app.post('/admin/api/logout', (req, res) => {
  deleteAdminSession(readBearer(req));
  res.json({ ok: true });
});

app.get('/admin/api/me', requireAdmin, (_req, res) => res.json({ ok: true }));

app.get('/admin/api/settings', requireAdmin, (_req, res) => res.json(getPublicSettings()));

app.put('/admin/api/settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  if (body.provider !== undefined) {
    if (!['gemini', 'openai', 'mock'].includes(body.provider)) {
      return res.status(400).json({ error: 'Provedor inválido.' });
    }
    setSetting('provider', body.provider);
  }
  for (const key of ['gemini_model', 'openai_model']) {
    if (typeof body[key] === 'string' && body[key].trim()) setSetting(key, body[key].trim().slice(0, 100));
  }
  // Chaves: string preenchida = substituir; null = remover; ausente = manter.
  for (const key of ['gemini_api_key', 'openai_api_key']) {
    if (body[key] === null) setSetting(key, null);
    else if (typeof body[key] === 'string' && body[key].trim()) setSetting(key, body[key].trim());
  }
  res.json(getPublicSettings());
});

app.get('/admin/api/codes', requireAdmin, (_req, res) => res.json(listAccessCodes()));

app.post('/admin/api/codes', requireAdmin, (req, res) => {
  const days = req.body?.expiresInDays ? Number(req.body.expiresInDays) : null;
  if (days !== null && (!Number.isFinite(days) || days <= 0 || days > 3650)) {
    return res.status(400).json({ error: 'Validade inválida (1 a 3650 dias).' });
  }
  res.status(201).json(createAccessCode({ label: req.body?.label || '', expiresInDays: days }));
});

app.patch('/admin/api/codes/:id', requireAdmin, (req, res) => {
  const ok = setAccessCodeActive(Number(req.params.id), Boolean(req.body?.active));
  ok ? res.json({ ok: true }) : res.status(404).json({ error: 'Código não encontrado.' });
});

app.delete('/admin/api/codes/:id', requireAdmin, (req, res) => {
  const ok = deleteAccessCode(Number(req.params.id));
  ok ? res.json({ ok: true }) : res.status(404).json({ error: 'Código não encontrado.' });
});

/* ------------------------------------------------------------------ */
/* Painel: em produção fica no GitHub Pages. Localmente, servimos ../docs */
/* ------------------------------------------------------------------ */
const docsDir = join(__dirname, '..', '..', 'docs');
if (existsSync(docsDir)) {
  app.use(
    '/admin',
    helmet.contentSecurityPolicy({ directives: { 'connect-src': ["'self'", 'https:', 'http://localhost:*'] } }),
    express.static(docsDir)
  );
  app.get('/', (_req, res) => res.redirect('/admin/'));
} else {
  app.get('/', (_req, res) => res.json({ name: 'Resolvy API', ok: true }));
}

app.listen(PORT, () => {
  console.log(`Resolvy rodando na porta ${PORT}`);
  console.log(`Banco de dados: ${dbPath}`);
  console.log(`Origens do painel: ${adminOrigins.length ? adminOrigins.join(', ') : 'qualquer (defina ADMIN_ORIGINS)'}`);
  console.log(`Extensões: ${allowedExtensionIds.length ? allowedExtensionIds.join(', ') : 'qualquer (defina ALLOWED_EXTENSION_IDS)'}`);
});
