import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  getPublicSettings,
  setSetting,
  createAccessCode,
  listAccessCodes,
  setAccessCodeActive,
  deleteAccessCode,
  validateAccessCode,
} from './db.js';
import { analyze, MODES } from './ai.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MAX_TEXT_CHARS = Number(process.env.MAX_TEXT_CHARS || 15000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD || ADMIN_PASSWORD === 'troque-esta-senha') {
  console.warn('⚠️  Defina ADMIN_PASSWORD no arquivo .env antes de usar em produção.');
}
if (!process.env.ENCRYPTION_KEY) {
  console.warn('⚠️  ENCRYPTION_KEY não definida: as chaves de API serão salvas sem criptografia.');
}

const app = express();
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.use(helmet());
app.use(express.json({ limit: '300kb' }));

/* ------------------------------------------------------------------ */
/* CORS: apenas para a extensão (chrome-extension://<id>)               */
/* ------------------------------------------------------------------ */
const allowedIds = (process.env.ALLOWED_EXTENSION_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin?.startsWith('chrome-extension://')) return false;
  if (allowedIds.length === 0) return true; // modo desenvolvimento
  return allowedIds.includes(origin.slice('chrome-extension://'.length));
}

app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  } else if (origin) {
    return res.status(403).json({ error: 'Origem não autorizada.' });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ------------------------------------------------------------------ */
/* API pública (usada pela extensão)                                    */
/* ------------------------------------------------------------------ */
const apiLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
const verifyLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

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
/* Painel administrativo                                                */
/* ------------------------------------------------------------------ */
const ADMIN_COOKIE = 'resolvy_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map(); // token -> expiresAt

function getCookie(req, name) {
  const match = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireAdmin(req, res, next) {
  const token = getCookie(req, ADMIN_COOKIE);
  const exp = token && sessions.get(token);
  if (!exp || exp < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: 'Não autenticado.' });
  }
  next();
}

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });

app.post('/admin/api/login', loginLimiter, (req, res) => {
  if (!ADMIN_PASSWORD || !safeEqual(req.body?.password ?? '', ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  res.cookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    maxAge: SESSION_TTL_MS,
    path: '/admin',
  });
  res.json({ ok: true });
});

app.post('/admin/api/logout', (req, res) => {
  const token = getCookie(req, ADMIN_COOKIE);
  if (token) sessions.delete(token);
  res.clearCookie(ADMIN_COOKIE, { path: '/admin' });
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

app.use('/admin', express.static(join(__dirname, '..', 'public', 'admin')));
app.get('/', (_req, res) => res.redirect('/admin/'));

app.listen(PORT, () => {
  console.log(`Resolvy rodando em http://localhost:${PORT}  (painel: /admin)`);
});
