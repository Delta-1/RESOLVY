import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import crypto from 'node:crypto';

// No Railway, se houver um Volume anexado, o banco vai para ele automaticamente.
const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
export const dbPath = resolve(process.env.DATABASE_PATH || (volume ? join(volume, 'resolvy.db') : './data/resolvy.db'));
mkdirSync(dirname(dbPath), { recursive: true });

if (process.env.RAILWAY_ENVIRONMENT && !volume && !process.env.DATABASE_PATH) {
  console.warn('⚠️  Nenhum Volume do Railway anexado: códigos e chaves serão PERDIDOS a cada deploy.');
}

export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
`);

/* ------------------------------------------------------------------ */
/* Sessões do painel (token Bearer; só o hash fica no banco)            */
/* ------------------------------------------------------------------ */

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createAdminSession(ttlMs) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO admin_sessions (token_hash, expires_at) VALUES (?, ?)').run(sha256(token), Date.now() + ttlMs);
  return token;
}

export function isValidAdminSession(token) {
  if (!token || token.length > 128) return false;
  const row = db.prepare('SELECT expires_at FROM admin_sessions WHERE token_hash = ?').get(sha256(token));
  return Boolean(row && row.expires_at > Date.now());
}

export function deleteAdminSession(token) {
  if (token) db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sha256(token));
}

/* ------------------------------------------------------------------ */
/* Criptografia das chaves de API (AES-256-GCM)                         */
/* ------------------------------------------------------------------ */

function getCipherKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;
  // Aceita qualquer string: deriva 32 bytes via SHA-256
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(plain) {
  const key = getCipherKey();
  if (!key) return `plain:${plain}`;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `gcm:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(stored) {
  if (stored.startsWith('plain:')) return stored.slice(6);
  const key = getCipherKey();
  if (!key) throw new Error('ENCRYPTION_KEY ausente: não é possível ler as chaves salvas.');
  const [, iv, tag, data] = stored.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/* ------------------------------------------------------------------ */
/* Configurações                                                        */
/* ------------------------------------------------------------------ */

const SECRET_KEYS = new Set(['gemini_api_key', 'openai_api_key']);

const DEFAULTS = {
  provider: 'gemini',
  gemini_model: 'gemini-2.5-flash',
  openai_model: 'gpt-4o-mini',
};

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const upsertStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);
const deleteSettingStmt = db.prepare('DELETE FROM settings WHERE key = ?');

export function getSetting(key) {
  const row = getStmt.get(key);
  if (!row) return DEFAULTS[key] ?? null;
  return SECRET_KEYS.has(key) ? decrypt(row.value) : row.value;
}

export function setSetting(key, value) {
  if (value === null || value === '') {
    deleteSettingStmt.run(key);
    return;
  }
  upsertStmt.run(key, SECRET_KEYS.has(key) ? encrypt(String(value)) : String(value));
}

function mask(secret) {
  if (!secret) return null;
  return `••••${secret.slice(-4)}`;
}

/** Visão segura das configurações para o painel (nunca devolve chaves completas). */
export function getPublicSettings() {
  return {
    provider: getSetting('provider'),
    gemini_model: getSetting('gemini_model'),
    openai_model: getSetting('openai_model'),
    gemini_api_key: mask(getSetting('gemini_api_key')),
    openai_api_key: mask(getSetting('openai_api_key')),
    encryption_enabled: Boolean(getCipherKey()),
  };
}

/* ------------------------------------------------------------------ */
/* Usuários da extensão (login + key)                                    */
/* ------------------------------------------------------------------ */
// A key fica criptografada (AES-256-GCM via ENCRYPTION_KEY), não só em hash,
// para que o administrador possa consultá-la no painel.

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    login        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    key_enc      TEXT NOT NULL,
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at   TEXT,
    last_used_at TEXT,
    usage_count  INTEGER NOT NULL DEFAULT 0
  );
`);

export const LOGIN_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const KEY_MIN = 4;
export const KEY_MAX = 64;

export function normalizeLogin(login) {
  return String(login ?? '').trim().toLowerCase();
}

/** Key curta e fácil de digitar: 6 caracteres sem ambíguos (0/O, 1/I/L). */
export function generateKey() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
}

const expiryFromDays = (days) => (days ? new Date(Date.now() + Number(days) * 86_400_000).toISOString() : null);

export function createUser({ login, key, expiresInDays = null }) {
  const finalKey = key || generateKey();
  const info = db
    .prepare('INSERT INTO users (login, key_enc, expires_at) VALUES (?, ?, ?)')
    .run(normalizeLogin(login), encrypt(finalKey), expiryFromDays(expiresInDays));
  return { id: Number(info.lastInsertRowid), login: normalizeLogin(login), key: finalKey };
}

export function loginExists(login) {
  return Boolean(db.prepare('SELECT 1 FROM users WHERE login = ?').get(normalizeLogin(login)));
}

export function listUsers() {
  return db
    .prepare(
      `SELECT id, login, active, created_at, expires_at, last_used_at, usage_count
       FROM users ORDER BY login`
    )
    .all();
}

export function getUserKey(id) {
  const row = db.prepare('SELECT key_enc FROM users WHERE id = ?').get(id);
  return row ? decrypt(row.key_enc) : null;
}

export function setUserKey(id, key) {
  return db.prepare('UPDATE users SET key_enc = ? WHERE id = ?').run(encrypt(key), id).changes > 0;
}

export function setUserActive(id, active) {
  return db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id).changes > 0;
}

export function deleteUser(id) {
  return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
}

/** Valida login + key. Retorna o usuário se válido, ou null. */
export function validateCredentials(login, key, { countUsage = false } = {}) {
  if (typeof login !== 'string' || typeof key !== 'string') return null;
  if (login.length > 64 || key.length > KEY_MAX) return null;
  const row = db
    .prepare('SELECT id, login, key_enc, active, expires_at FROM users WHERE login = ?')
    .get(normalizeLogin(login));
  // Compara mesmo quando o login não existe, para não revelar quais logins existem pelo tempo de resposta.
  const stored = row ? decrypt(row.key_enc) : generateKey();
  const a = crypto.createHash('sha256').update(stored).digest();
  const b = crypto.createHash('sha256').update(key.trim()).digest();
  if (!row || !crypto.timingSafeEqual(a, b) || !row.active) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
  if (countUsage) {
    db.prepare("UPDATE users SET usage_count = usage_count + 1, last_used_at = datetime('now') WHERE id = ?").run(row.id);
  }
  return { id: row.id, login: row.login, expires_at: row.expires_at };
}
