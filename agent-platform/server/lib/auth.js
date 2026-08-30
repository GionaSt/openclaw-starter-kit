// Autenticazione utenti: password con scrypt (crypto nativo), token firmati HMAC
// con segreto random persistito su disco, ruoli e permessi per tenant/agente.
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { readJson, writeJson, DATA_DIR, CONFIG_DIR } from './store.js';

const USERS_FILE = join(CONFIG_DIR, 'users.json');
const SECRET_FILE = join(DATA_DIR, 'secret.key');
export const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 giorni

// Segreto di firma: generato al primo avvio, mai hardcoded, gitignored.
function loadSecret() {
  if (existsSync(SECRET_FILE)) return readFileSync(SECRET_FILE, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}
const SECRET = loadSecret();

// ---- Password hashing (scrypt) ----
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored ?? '').split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const calc = scryptSync(password, salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return calc.length === ref.length && timingSafeEqual(calc, ref);
}

// ---- Utenti ----
let usersCache = null;
export function loadUsers() {
  if (!usersCache) usersCache = readJson(USERS_FILE, { users: [] });
  return usersCache.users;
}
export function saveUsers(users) {
  usersCache = { users };
  writeJson(USERS_FILE, usersCache);
}
export function findUser(username) {
  return loadUsers().find((u) => u.username === username) ?? null;
}

export const ROLES = ['admin', 'manager', 'collaborator'];

// Seed: se non esiste nessun utente, crea l'admin "admin" con password random
// scritta (una tantum) in data/initial-admin-password.txt e in console.
export function ensureSeedAdmin() {
  if (loadUsers().length > 0) return;
  const password = randomBytes(9).toString('base64url');
  saveUsers([{
    username: 'admin',
    passwordHash: hashPassword(password),
    role: 'admin',
    tenants: ['*'],
    agents: ['*'],
    createdAt: new Date().toISOString(),
  }]);
  const noteFile = join(DATA_DIR, 'initial-admin-password.txt');
  writeFileSync(noteFile, `utente: admin\npassword: ${password}\n(cambiala e cancella questo file)\n`, { mode: 0o600 });
  console.log(`[auth] Creato admin seed "admin" — password iniziale in ${noteFile}`);
}

// ---- Token firmati: base64url(payload).firma ----
export function signToken(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyToken(token) {
  const [payload, sig] = String(token ?? '').split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!u || Date.now() > exp) return null;
    return findUser(u);
  } catch {
    return null;
  }
}

// ---- Permessi ----
export function userCanTenant(user, tenantId) {
  if (!user || !tenantId) return false;
  if (user.role === 'admin') return true;
  return user.tenants?.includes('*') || user.tenants?.includes(tenantId);
}

export function userCanAgent(user, tenantId, agentId) {
  if (!userCanTenant(user, tenantId)) return false;
  if (user.role === 'admin') return true;
  return user.agents?.includes('*') || user.agents?.includes(agentId);
}

export function publicUser(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}

// Middleware Express
export function authMiddleware(req, res, next) {
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ error: 'non autenticato' });
  req.user = user;
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) return res.status(403).json({ error: 'permessi insufficienti' });
    next();
  };
}

export function requireTenant(req, res, next) {
  const tenantId = req.params.tenantId ?? req.query.tenantId ?? req.body?.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'tenantId richiesto' });
  if (!userCanTenant(req.user, tenantId)) return res.status(403).json({ error: 'tenant non assegnato' });
  req.tenantId = tenantId;
  next();
}
