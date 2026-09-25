const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite'); // built into Node.js 22+, no extra package needed
let Arifpay = null, arifpay = null;
try {
  Arifpay = require('arifpay');
  Arifpay = Arifpay.default || Arifpay;
  if (process.env.ARIFPAY_API_KEY) arifpay = new Arifpay(process.env.ARIFPAY_API_KEY);
} catch (e) { console.warn('ArifPay package not available yet — install with `npm install arifpay`.'); }

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DB_FILE = path.join(ROOT, 'data', 'palm-palace.db');
const OLD_STORE = path.join(ROOT, 'data', 'store.json');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const LOGIN_WINDOW_MS = 15 * 60 * 1000;     // 15 minutes
const LOGIN_MAX_ATTEMPTS = 5;

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(ROOT, 'public')));

// ---------- Database setup ----------
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, role TEXT NOT NULL,
  password_hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, source TEXT NOT NULL,
  room_type TEXT NOT NULL, room_number TEXT NOT NULL,
  check_in TEXT NOT NULL, check_out TEXT NOT NULL, nights INTEGER NOT NULL,
  total INTEGER NOT NULL, breakfast INTEGER NOT NULL,
  guest_full_name TEXT NOT NULL, guest_phone TEXT NOT NULL,
  guest_email TEXT, guest_notes TEXT,
  created_at TEXT NOT NULL, created_by TEXT
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, method TEXT NOT NULL,
  status TEXT NOT NULL, amount INTEGER NOT NULL, reference TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS room_overrides (
  room_number TEXT PRIMARY KEY, state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_room ON bookings(room_number, check_in, check_out);
`);
try { db.exec('ALTER TABLE bookings ADD COLUMN arifpay_session_id TEXT'); } catch (e) {} // idempotent migration

// One-time migration from the old data/store.json, if present and DB is empty
(function migrateFromJsonIfNeeded() {
  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (userCount > 0 || !fs.existsSync(OLD_STORE)) return;
  try {
    const old = JSON.parse(fs.readFileSync(OLD_STORE, 'utf8'));
    const insUser = db.prepare('INSERT OR IGNORE INTO users VALUES (?,?,?,?,?,?)');
    (old.users || []).forEach(u => insUser.run(u.id, u.username, u.role, u.passwordHash, u.disabled ? 1 : 0, u.createdAt));
    const insBooking = db.prepare(`INSERT OR IGNORE INTO bookings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    (old.bookings || []).forEach(b => insBooking.run(b.id, b.status, b.source, b.roomType, b.roomNumber, b.checkIn, b.checkOut, b.nights, b.total, b.breakfast, b.guest?.fullName || '', b.guest?.phone || '', b.guest?.email || '', b.guest?.notes || '', b.createdAt, b.createdBy || null));
    const insPay = db.prepare('INSERT OR IGNORE INTO payments VALUES (?,?,?,?,?,?,?)');
    (old.payments || []).forEach(p => insPay.run(p.id, p.bookingId, p.method, p.status, p.amount, p.reference || '', p.createdAt));
    const insAudit = db.prepare('INSERT OR IGNORE INTO audit_logs VALUES (?,?,?,?,?)');
    (old.auditLogs || []).forEach(a => insAudit.run(a.id, a.userId, a.action, JSON.stringify(a.details || {}), a.createdAt));
    const insOverride = db.prepare('INSERT OR REPLACE INTO room_overrides VALUES (?,?)');
    Object.entries(old.roomOverrides || {}).forEach(([number, state]) => insOverride.run(number, state));
    console.log('Migrated existing data/store.json into SQLite.');
  } catch (e) {
    console.error('Migration from store.json failed (continuing with empty DB):', e.message);
  }
})();

// ---------- Static hotel data ----------
const prices = { Single: 1546, King: 2060, Double: 2576, Family: 4120 };
const breakfast = { Single: 1, King: 2, Double: 2, Family: 4 };
const rooms = [['101','Single'],['102','Single'],['103','Double'],['104','King'],['105','King'],['106','Double'],['107','Single'],['108','Single'],['201','Single'],['202','Single'],['203','Double'],['204','King'],['205','King'],['206','Single'],['207','Family'],['208','King'],['209','King'],['210','King'],['211','Single'],['212','Single'],['301','Single'],['302','Single'],['303','Double'],['304','King'],['305','King'],['306','Single'],['307','Family'],['308','King'],['309','King'],['310','King'],['311','Single'],['312','Single'],['401','Single'],['402','Single'],['403','Double'],['404','King'],['405','King'],['406','Single'],['407','Family'],['408','King'],['409','King'],['410','King'],['411','Single'],['412','Single'],['501','Single'],['502','Single'],['503','King'],['504','King'],['505','King'],['506','Single'],['507','Family']].map(([number, type]) => ({ number, type, floor: number[0] }));
const OUT = new Set(['302', '507']);

function id(prefix) { return `${prefix}-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }
function hash(p, s = crypto.randomBytes(16).toString('hex')) { return `${s}:${crypto.scryptSync(p, s, 64).toString('hex')}`; }
function verify(p, h) { const [s, x] = String(h).split(':'); if (!s || !x) return false; try { return crypto.timingSafeEqual(Buffer.from(x, 'hex'), crypto.scryptSync(p, s, 64)); } catch { return false; } }
function dateNights(a, b) { const x = new Date(a + 'T00:00:00Z'), y = new Date(b + 'T00:00:00Z'); return Math.ceil((y - x) / 86400000); }

function seedAdmin() {
  const existing = db.prepare('SELECT 1 FROM users WHERE username = ?').get(process.env.SUPER_ADMIN_USERNAME || 'admin');
  if (existing) return;
  const username = process.env.SUPER_ADMIN_USERNAME || 'admin';
  const password = process.env.SUPER_ADMIN_PASSWORD || 'CHANGE-ME-NOW';
  db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(id('USR'), username, 'SUPER_ADMIN', hash(password), 0, new Date().toISOString());
}
seedAdmin();

// ---------- Sessions (DB-backed, survive restarts) ----------
function createSession(userId) {
  const t = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(t, userId, now, now + SESSION_TTL_MS);
  return t;
}
function getSession(token) {
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); return null; }
  return row;
}
function deleteSession(token) { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); }
setInterval(() => { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); }, 60 * 60 * 1000).unref();

// ---------- Login rate limiting (per IP, in-memory sliding window) ----------
const loginAttempts = new Map(); // ip -> { count, windowStart }
function checkRateLimit(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now - rec.windowStart > LOGIN_WINDOW_MS) { loginAttempts.set(ip, { count: 1, windowStart: now }); return { blocked: false }; }
  rec.count += 1;
  if (rec.count > LOGIN_MAX_ATTEMPTS) return { blocked: true, retryAfterSec: Math.ceil((rec.windowStart + LOGIN_WINDOW_MS - now) / 1000) };
  return { blocked: false };
}
setInterval(() => { const now = Date.now(); for (const [ip, rec] of loginAttempts) if (now - rec.windowStart > LOGIN_WINDOW_MS) loginAttempts.delete(ip); }, 30 * 60 * 1000).unref();

function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '') || req.headers['x-session-token'];
  const s = t && getSession(t);
  if (!s) return res.status(401).json({ error: 'Authentication required' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  if (!u || u.disabled) return res.status(401).json({ error: 'Account disabled' });
  req.user = u;
  req.sessionToken = t;
  next();
}
function role(...roles) { return (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Permission denied' }); }
function audit(user, action, details) {
  db.prepare('INSERT INTO audit_logs VALUES (?,?,?,?,?)').run(id('AUD'), user?.id || null, action, JSON.stringify(details || {}), new Date().toISOString());
}

// ---------- Booking helpers ----------
function roomState(r) {
  const row = db.prepare('SELECT state FROM room_overrides WHERE room_number = ?').get(r.number);
  if (row) return row.state;
  return OUT.has(r.number) ? 'OUT_OF_SERVICE' : 'AVAILABLE';
}
const ACTIVE_STATUSES = ['PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN'];
function roomIsFree(roomNumber, checkIn, checkOut) {
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
  const clash = db.prepare(`SELECT 1 FROM bookings WHERE room_number = ? AND status IN (${placeholders}) AND check_in < ? AND check_out > ? LIMIT 1`)
    .get(roomNumber, ...ACTIVE_STATUSES, checkOut, checkIn);
  return !clash;
}
function availableRooms(checkIn, checkOut, type) {
  return rooms.filter(r => roomState(r) === 'AVAILABLE' && (!type || r.type === type) && roomIsFree(r.number, checkIn, checkOut));
}
function calculate(type, ci, co) {
  if (!prices[type]) throw Error('Invalid room type');
  const nights = dateNights(ci, co);
  if (!Number.isInteger(nights) || nights < 1) throw Error('Invalid stay dates');
  return { nights, total: prices[type] * nights };
}
function rowToBooking(b) {
  return { id: b.id, status: b.status, source: b.source, roomType: b.room_type, roomNumber: b.room_number, checkIn: b.check_in, checkOut: b.check_out, nights: b.nights, total: b.total, breakfast: b.breakfast, guest: { fullName: b.guest_full_name, phone: b.guest_phone, email: b.guest_email, notes: b.guest_notes }, createdAt: b.created_at, createdBy: b.created_by };
}
function createBooking(body, source = 'ONLINE', actor = null) {
  const { roomType, roomNumber, checkIn, checkOut, guest } = body;
  if (!roomType || !roomNumber || !checkIn || !checkOut || !guest?.fullName || !guest?.phone) throw Error('Required booking information is missing');
  const room = rooms.find(r => r.number === roomNumber && r.type === roomType);
  if (!room || roomState(room) !== 'AVAILABLE') throw Error('Selected room is unavailable');
  const calc = calculate(roomType, checkIn, checkOut);
  if (!roomIsFree(roomNumber, checkIn, checkOut)) throw Object.assign(new Error('Room has just been booked. Please select another room.'), { status: 409 });
  const bookingId = id('PPH');
  const status = source === 'WALK_IN' ? 'CONFIRMED' : 'PENDING_PAYMENT';
  const createdAt = new Date().toISOString();
  db.prepare('INSERT INTO bookings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    bookingId, status, source, roomType, roomNumber, checkIn, checkOut, calc.nights, calc.total, breakfast[roomType],
    guest.fullName.trim(), guest.phone.trim(), (guest.email || '').trim(), guest.notes || '', createdAt, actor?.id || null
  );
  if (source === 'WALK_IN') {
    db.prepare('INSERT INTO payments VALUES (?,?,?,?,?,?,?)').run(id('PAY'), bookingId, 'OFFLINE', 'PENDING', calc.total, '', createdAt);
  }
  audit(actor, source === 'WALK_IN' ? 'CREATE_WALK_IN' : 'CREATE_ONLINE', { bookingId, roomNumber });
  return rowToBooking(db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId));
}

// ---------- Public API ----------
app.get('/api/health', (q, s) => s.json({ ok: true, service: 'Palm Palace Hotel', rooms: rooms.length }));
app.get('/api/rooms', (q, s) => s.json({ rooms: rooms.map(r => ({ ...r, state: roomState(r) })), prices, breakfast }));
app.get('/api/availability', (q, s) => {
  try {
    const { checkIn, checkOut, type } = q.query;
    if (!checkIn || !checkOut) throw Error('checkIn and checkOut are required');
    calculate(type || 'Single', checkIn, checkOut);
    const a = availableRooms(checkIn, checkOut, type);
    s.json({ rooms: a, count: a.length });
  } catch (e) { s.status(400).json({ error: e.message }); }
});
app.post('/api/bookings', (q, s) => {
  try { s.status(201).json({ booking: createBooking(q.body) }); }
  catch (e) { s.status(e.status || 400).json({ error: e.message }); }
});
app.get('/api/bookings/:id', (q, s) => {
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(q.params.id);
  if (!row) return s.status(404).json({ error: 'Booking not found' });
  s.json({ booking: rowToBooking(row) });
});
app.post('/api/bookings/:id/payment-intent', async (q, s) => {
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(q.params.id);
  if (!row) return s.status(404).json({ error: 'Booking not found' });
  if (row.status !== 'PENDING_PAYMENT') return s.status(409).json({ error: 'Booking is not awaiting payment' });
  const base = process.env.PUBLIC_BASE_URL || `${q.protocol}://${q.get('host')}`;
  if (arifpay) {
    try {
      const nonce = crypto.randomBytes(8).toString('hex');
      const expire = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const data = {
        cancelUrl: `${base}/#book`, errorUrl: `${base}/#book`, successUrl: `${base}/#book`,
        notifyUrl: `${base}/api/arifpay/webhook`,
        nonce, expireDate: expire, paymentMethods: [],
        items: [{ name: `${row.room_type} Room — ${row.nights} night(s), Room ${row.room_number}`, price: row.total, quantity: 1 }],
        beneficiaries: process.env.ARIFPAY_BENEFICIARY_ACCOUNT ? [{ accountNumber: process.env.ARIFPAY_BENEFICIARY_ACCOUNT, bank: process.env.ARIFPAY_BENEFICIARY_BANK || 'CBETETAA', amount: row.total }] : undefined
      };
      const session = await arifpay.checkout.create(data, { sandbox: process.env.ARIFPAY_SANDBOX !== 'false' });
      const sessionId = session.sessionId || session.data?.sessionId;
      if (sessionId) db.prepare('UPDATE bookings SET arifpay_session_id = ? WHERE id = ?').run(sessionId, row.id);
      return s.json({ bookingId: row.id, amount: row.total, paymentUrl: session.paymentUrl || session.data?.paymentUrl, status: 'REDIRECT', provider: 'arifpay' });
    } catch (e) {
      console.error('ArifPay session creation failed:', e.message);
      return s.status(502).json({ error: 'ArifPay request failed', detail: e.message });
    }
  }
  if (!process.env.PAYMENT_GATEWAY_URL) return s.status(503).json({ error: 'Payment gateway is not configured for this hotel yet.', bookingId: row.id, amount: row.total });
  try {
    const r = await fetch(process.env.PAYMENT_GATEWAY_URL, { method: 'POST', headers: { 'content-type': 'application/json', ...(process.env.PAYMENT_GATEWAY_KEY ? { authorization: `Bearer ${process.env.PAYMENT_GATEWAY_KEY}` } : {}) }, body: JSON.stringify({ reference: row.id, amount: row.total, currency: 'ETB', customer: { fullName: row.guest_full_name, phone: row.guest_phone, email: row.guest_email } }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(data.message || 'Gateway rejected payment request');
    s.json({ bookingId: row.id, amount: row.total, paymentUrl: data.paymentUrl || data.checkoutUrl || data.url, status: 'REDIRECT' });
  } catch (e) { s.status(502).json({ error: 'Payment gateway request failed', detail: e.message }); }
});
// Manual/offline payment confirmation, gated by a shared code the hotel keeps privately (bank transfer, cash, etc.)
app.post('/api/bookings/:id/confirm-payment', (q, s) => {
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(q.params.id);
  if (!row) return s.status(404).json({ error: 'Booking not found' });
  if (row.status !== 'PENDING_PAYMENT') return s.status(409).json({ error: 'Booking is not awaiting payment' });
  const secret = process.env.PAYMENT_CONFIRM_PASSWORD;
  if (!secret) return s.status(503).json({ error: 'Payment confirmation is not configured for this hotel yet.' });
  const given = String((q.body || {}).password || '');
  const match = given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!match) { audit(null, 'PAYMENT_PASSWORD_FAILED', { bookingId: row.id }); return s.status(401).json({ error: 'Incorrect payment confirmation code.' }); }
  db.prepare("UPDATE bookings SET status = 'CONFIRMED' WHERE id = ?").run(row.id);
  db.prepare('INSERT INTO payments VALUES (?,?,?,?,?,?,?)').run(id('PAY'), row.id, 'MANUAL', 'PAID', row.total, '', new Date().toISOString());
  audit(null, 'PAYMENT_CONFIRMED_MANUAL', { bookingId: row.id });
  s.json({ booking: rowToBooking(db.prepare('SELECT * FROM bookings WHERE id = ?').get(row.id)) });
});
// ArifPay sends a notification here once a checkout session's status changes.
// We NEVER trust the webhook body for the final decision — we re-fetch the session from
// ArifPay's API (the authoritative source) before marking any booking as paid.
// NOTE: once real sandbox testing is possible, check the logged `session` output and confirm
// the exact status field/value ArifPay returns (this handles common shapes defensively for now).
app.post('/api/arifpay/webhook', async (q, s) => {
  try {
    const sessionId = q.body?.sessionId || q.body?.data?.sessionId || q.body?.session_id;
    if (!sessionId || !arifpay) return s.status(400).json({ error: 'Missing sessionId or ArifPay not configured' });
    const row = db.prepare('SELECT * FROM bookings WHERE arifpay_session_id = ?').get(sessionId);
    if (!row) return s.status(404).json({ error: 'No booking matches this session' });
    const session = await arifpay.checkout.fetch(sessionId, { sandbox: process.env.ARIFPAY_SANDBOX !== 'false' });
    console.log('ArifPay session status check:', JSON.stringify(session));
    const statusValue = String(session?.transcation?.status || session?.transaction?.status || session?.status || '').toUpperCase();
    const paid = statusValue.includes('SUCCESS') || statusValue.includes('PAID') || statusValue.includes('COMPLETE');
    if (!paid) return s.json({ ok: true, status: statusValue || 'PENDING' });
    if (row.status === 'CONFIRMED') return s.json({ ok: true, idempotent: true });
    db.prepare("UPDATE bookings SET status = 'CONFIRMED' WHERE id = ?").run(row.id);
    db.prepare('INSERT INTO payments VALUES (?,?,?,?,?,?,?)').run(id('PAY'), row.id, 'ARIFPAY', 'PAID', row.total, sessionId, new Date().toISOString());
    s.json({ ok: true, status: 'CONFIRMED' });
  } catch (e) { console.error('ArifPay webhook error:', e.message); s.status(500).json({ error: 'Webhook processing failed' }); }
});
app.post('/api/payments/webhook', (q, s) => {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (secret) { const sig = q.headers['x-webhook-secret']; if (sig !== secret) return s.status(401).json({ error: 'Invalid webhook signature' }); }
  const { bookingId, reference, status, amount, transactionId } = q.body;
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId || reference);
  if (!row) return s.status(404).json({ error: 'Booking not found' });
  if (status !== 'PAID') return s.json({ ok: true });
  if (Number(amount) !== Number(row.total)) return s.status(400).json({ error: 'Amount mismatch' });
  if (row.status === 'CONFIRMED') return s.json({ ok: true, idempotent: true });
  db.prepare("UPDATE bookings SET status = 'CONFIRMED' WHERE id = ?").run(row.id);
  db.prepare('INSERT INTO payments VALUES (?,?,?,?,?,?,?)').run(id('PAY'), row.id, 'GATEWAY', 'PAID', row.total, transactionId || reference || row.id, new Date().toISOString());
  s.json({ ok: true });
});

// ---------- Admin API ----------
app.post('/api/admin/login', (q, s) => {
  const ip = q.headers['x-forwarded-for']?.split(',')[0]?.trim() || q.socket.remoteAddress || 'unknown';
  const limit = checkRateLimit(ip);
  if (limit.blocked) {
    audit(null, 'LOGIN_RATE_LIMITED', { ip });
    s.set('Retry-After', String(limit.retryAfterSec));
    return s.status(429).json({ error: `Too many login attempts. Try again in ${Math.ceil(limit.retryAfterSec / 60)} minute(s).` });
  }
  const { username, password } = q.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ? AND disabled = 0').get(username);
  if (!u || !verify(password || '', u.password_hash)) return s.status(401).json({ error: 'Invalid username or password' });
  const t = createSession(u.id);
  s.json({ token: t, user: { id: u.id, username: u.username, role: u.role } });
});
app.post('/api/admin/logout', auth, (q, s) => { deleteSession(q.sessionToken); s.json({ ok: true }); });
app.get('/api/admin/me', auth, (q, s) => s.json({ user: { id: q.user.id, username: q.user.username, role: q.user.role } }));
app.get('/api/admin/dashboard', auth, role('SUPER_ADMIN', 'RECEPTION', 'FINANCE'), (q, s) => {
  const today = new Date().toISOString().slice(0, 10);
  const confirmedCount = db.prepare("SELECT COUNT(*) c FROM bookings WHERE status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT')").get().c;
  const todayCount = db.prepare('SELECT COUNT(*) c FROM bookings WHERE created_at LIKE ?').get(today + '%').c;
  const revenue = db.prepare("SELECT COALESCE(SUM(amount),0) r FROM payments WHERE status = 'PAID'").get().r;
  const pending = db.prepare("SELECT COUNT(*) c FROM bookings WHERE status = 'PENDING_PAYMENT'").get().c;
  const outOfService = rooms.filter(r => roomState(r) !== 'AVAILABLE').length;
  s.json({ rooms: rooms.length, available: rooms.length - outOfService, outOfService, todayBookings: todayCount, confirmed: confirmedCount, revenue, pending });
});
app.get('/api/admin/bookings', auth, role('SUPER_ADMIN', 'RECEPTION', 'FINANCE'), (q, s) => {
  const rowsArr = q.query.status
    ? db.prepare('SELECT * FROM bookings WHERE status = ? ORDER BY created_at DESC LIMIT 500').all(q.query.status)
    : db.prepare('SELECT * FROM bookings ORDER BY created_at DESC LIMIT 500').all();
  s.json({ bookings: rowsArr.map(rowToBooking) });
});
app.post('/api/admin/bookings/walk-in', auth, role('SUPER_ADMIN', 'RECEPTION'), (q, s) => {
  try { s.status(201).json({ booking: createBooking(q.body, 'WALK_IN', q.user) }); }
  catch (e) { s.status(e.status || 400).json({ error: e.message }); }
});
app.post('/api/admin/bookings/:id/status', auth, role('SUPER_ADMIN', 'RECEPTION'), (q, s) => {
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(q.params.id);
  if (!row) return s.status(404).json({ error: 'Booking not found' });
  const allowed = ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW'];
  if (!allowed.includes(q.body.status)) return s.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(q.body.status, row.id);
  audit(q.user, 'UPDATE_BOOKING_STATUS', { bookingId: row.id, status: q.body.status });
  s.json({ booking: rowToBooking(db.prepare('SELECT * FROM bookings WHERE id = ?').get(row.id)) });
});
app.get('/api/admin/payments', auth, role('SUPER_ADMIN', 'FINANCE'), (q, s) => s.json({ payments: db.prepare('SELECT * FROM payments ORDER BY created_at DESC LIMIT 1000').all() }));
app.post('/api/admin/rooms/:number/state', auth, role('SUPER_ADMIN'), (q, s) => {
  const r = rooms.find(x => x.number === q.params.number);
  if (!r) return s.status(404).json({ error: 'Room not found' });
  const state = q.body.state;
  if (!['AVAILABLE', 'OUT_OF_SERVICE', 'MAINTENANCE'].includes(state)) return s.status(400).json({ error: 'Invalid room state' });
  if (state === 'AVAILABLE') db.prepare('DELETE FROM room_overrides WHERE room_number = ?').run(r.number);
  else db.prepare('INSERT OR REPLACE INTO room_overrides VALUES (?,?)').run(r.number, state);
  audit(q.user, 'ROOM_STATE_CHANGE', { roomNumber: r.number, state });
  s.json({ room: { ...r, state: roomState(r) } });
});
app.get('/api/admin/users', auth, role('SUPER_ADMIN'), (q, s) => s.json({ users: db.prepare('SELECT id, username, role, disabled, created_at as createdAt FROM users').all() }));
app.post('/api/admin/users', auth, role('SUPER_ADMIN'), (q, s) => {
  const { username, password, role: r } = q.body || {};
  if (!username || !password || !['SUPER_ADMIN', 'RECEPTION', 'FINANCE'].includes(r)) return s.status(400).json({ error: 'username, password and valid role required' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return s.status(409).json({ error: 'Username already exists' });
  const uid = id('USR');
  db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(uid, username, r, hash(password), 0, new Date().toISOString());
  audit(q.user, 'CREATE_USER', { username, role: r });
  s.status(201).json({ user: { id: uid, username, role: r, disabled: false } });
});
app.post('/api/admin/users/:id/disable', auth, role('SUPER_ADMIN'), (q, s) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(q.params.id);
  if (!u) return s.status(404).json({ error: 'User not found' });
  if (u.id === q.user.id) return s.status(400).json({ error: 'You cannot disable your own account' });
  db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  audit(q.user, 'DISABLE_USER', { userId: u.id });
  s.json({ ok: true });
});
app.get('/api/admin/audit', auth, role('SUPER_ADMIN'), (q, s) => {
  const rowsArr = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 500').all();
  s.json({ auditLogs: rowsArr.map(a => ({ ...a, details: (() => { try { return JSON.parse(a.details); } catch { return {}; } })() })) });
});

app.use((req, res) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) return res.sendFile(path.join(ROOT, 'public', 'index.html'));
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => console.log(`Palm Palace Hotel: http://localhost:${PORT}`));
