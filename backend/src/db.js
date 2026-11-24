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

  CREATE TABLE IF NOT EXISTS access_codes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    code_hash    TEXT NOT NULL UNIQUE,
    code_hint    TEXT NOT NULL,
    label        TEXT NOT NULL DEFAULT '',
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at   TEXT,
    last_used_at TEXT,
    usage_count  INTEGER NOT NULL DEFAULT 0
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
/* Códigos de acesso                                                    */
/* ------------------------------------------------------------------ */

const hashCode = (code) => crypto.createHash('sha256').update(code.trim().toUpperCase()).digest('hex');

/** Gera um código legível no formato RSV-XXXX-XXXX-XXXX (sem caracteres ambíguos). */
function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  return `RSV-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export function createAccessCode({ label = '', expiresInDays = null } = {}) {
  const code = generateCode();
  const expiresAt = expiresInDays
    ? new Date(Date.now() + Number(expiresInDays) * 86_400_000).toISOString()
    : null;
  const info = db
    .prepare('INSERT INTO access_codes (code_hash, code_hint, label, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashCode(code), code.slice(-4), String(label).slice(0, 100), expiresAt);
  // O código em texto puro só é devolvido aqui, uma única vez.
  return { id: Number(info.lastInsertRowid), code, label, expires_at: expiresAt };
}

export function listAccessCodes() {
  return db
    .prepare(
      `SELECT id, code_hint, label, active, created_at, expires_at, last_used_at, usage_count
       FROM access_codes ORDER BY id DESC`
    )
    .all();
}

export function setAccessCodeActive(id, active) {
  return db.prepare('UPDATE access_codes SET active = ? WHERE id = ?').run(active ? 1 : 0, id).changes > 0;
}

export function deleteAccessCode(id) {
  return db.prepare('DELETE FROM access_codes WHERE id = ?').run(id).changes > 0;
}

/** Valida um código. Retorna o registro se válido, ou null. */
export function validateAccessCode(code, { countUsage = false } = {}) {
  if (!code || typeof code !== 'string' || code.length > 64) return null;
  const row = db
    .prepare('SELECT id, label, active, expires_at FROM access_codes WHERE code_hash = ?')
    .get(hashCode(code));
  if (!row || !row.active) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
  if (countUsage) {
    db.prepare(
      "UPDATE access_codes SET usage_count = usage_count + 1, last_used_at = datetime('now') WHERE id = ?"
    ).run(row.id);
  }
  return row;
}
