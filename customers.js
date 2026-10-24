// Shop visitor accounts: register, login, profile (used to fill the checkout form)
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const { makeCustomerToken, requireCustomer, requireAdmin } = require('./auth');
const { sendMail, configured } = require('./mailer');

const router = express.Router();

// small in-memory limiter: 12 register/login tries per 15 minutes per IP
const tries = new Map();
function limited(req, res, next) {
  const ip = req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.ip;
  const now = Date.now();
  const list = (tries.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  if (list.length >= 12) return res.status(429).json({ error: 'Too many attempts. Please try again in a few minutes.' });
  list.push(now);
  tries.set(ip, list);
  next();
}

const clean = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));

function publicProfile(c) {
  return {
    firstName: c.first_name, lastName: c.last_name, phone: c.phone, email: c.email,
    company: c.company || '', gst: c.gst || '', address: c.address || '', city: c.city || '', state: c.state || '', pin: c.pin || ''
  };
}

function readProfile(body, needAll) {
  const d = {
    first_name: clean(body.firstName, 80), last_name: clean(body.lastName, 80),
    phone: clean(body.phone, 15).replace(/\D/g, '').slice(-10), email: clean(body.email, 160).toLowerCase(),
    company: clean(body.company, 160) || null, gst: clean(body.gst, 30).toUpperCase() || null,
    address: clean(body.address, 300), city: clean(body.city, 100), state: clean(body.state, 100), pin: clean(body.pin, 10)
  };
  if (!d.first_name || !d.last_name) return { error: 'Please enter your first and last name.' };
  if (!/^[6-9][0-9]{9}$/.test(d.phone)) return { error: 'Please enter a valid 10-digit mobile number.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return { error: 'Please enter a valid email address.' };
  if (needAll && (!d.address || !d.city || !d.state)) return { error: 'Please fill in your delivery address, city and state.' };
  if (d.pin && !/^[0-9]{6}$/.test(d.pin)) return { error: 'PIN code must be 6 digits.' };
  if (needAll && !d.pin) return { error: 'Please enter your 6-digit PIN code.' };
  return { d };
}

router.post('/api/auth/register', limited, async (req, res, next) => {
  try {
    const body = req.body || {};
    const { d, error } = readProfile(body, true);
    if (error) return res.status(400).json({ error });
    const password = String(body.password || '');
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    const [dup] = await pool.query('SELECT phone, email FROM customers WHERE phone = ? OR email = ?', [d.phone, d.email]);
    if (dup.length) {
      return res.status(409).json({ error: dup[0].phone === d.phone ? 'This mobile number is already registered. Please log in.' : 'This email is already registered. Please log in.' });
    }
    const hash = await bcrypt.hash(password, 10);
    const [ins] = await pool.query(
      'INSERT INTO customers (first_name, last_name, phone, email, password_hash, company, gst, address, city, state, pin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [d.first_name, d.last_name, d.phone, d.email, hash, d.company, d.gst, d.address, d.city, d.state, d.pin]
    );
    const [rows] = await pool.query('SELECT * FROM customers WHERE id = ?', [ins.insertId]);
    res.json({ token: makeCustomerToken(ins.insertId), profile: publicProfile(rows[0]) });
  } catch (e) { next(e); }
});

router.post('/api/auth/login', limited, async (req, res, next) => {
  try {
    const id = clean((req.body || {}).login, 160).toLowerCase();
    const password = String((req.body || {}).password || '');
    if (!id || !password) return res.status(400).json({ error: 'Please enter your mobile number or email and your password.' });
    const phone = id.replace(/\D/g, '').slice(-10);
    const [rows] = await pool.query('SELECT * FROM customers WHERE email = ? OR phone = ?', [id, !id.includes('@') && /^[6-9][0-9]{9}$/.test(phone) ? phone : '-']);
    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
      return res.status(401).json({ error: 'Wrong mobile/email or password.' });
    }
    res.json({ token: makeCustomerToken(rows[0].id), profile: publicProfile(rows[0]) });
  } catch (e) { next(e); }
});

router.get('/api/auth/me', requireCustomer, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM customers WHERE id = ?', [req.customerId]);
    if (!rows.length) return res.status(401).json({ error: 'Please log in again' });
    res.json({ profile: publicProfile(rows[0]) });
  } catch (e) { next(e); }
});

// saves the delivery details (called from checkout so next time the form is already filled)
router.put('/api/auth/me', requireCustomer, async (req, res, next) => {
  try {
    const { d, error } = readProfile(req.body || {}, false);
    if (error) return res.status(400).json({ error });
    const [dup] = await pool.query('SELECT id FROM customers WHERE (phone = ? OR email = ?) AND id <> ?', [d.phone, d.email, req.customerId]);
    if (dup.length) return res.status(409).json({ error: 'That mobile number or email belongs to another account.' });
    await pool.query(
      'UPDATE customers SET first_name=?, last_name=?, phone=?, email=?, company=?, gst=?, address=?, city=?, state=?, pin=? WHERE id=?',
      [d.first_name, d.last_name, d.phone, d.email, d.company, d.gst, d.address || null, d.city || null, d.state || null, d.pin || null, req.customerId]
    );
    const [rows] = await pool.query('SELECT * FROM customers WHERE id = ?', [req.customerId]);
    res.json({ profile: publicProfile(rows[0]) });
  } catch (e) { next(e); }
});

// ---------- forgot / reset password (email link, valid for 1 hour) ----------

const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const escHtml = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

router.post('/api/auth/forgot', limited, async (req, res) => {
  // always the same answer, so nobody can use this to find out who is registered
  const reply = () => res.json({ ok: true, message: 'If this email is registered, we have sent a link to reset the password. Please check your inbox (and spam folder).' });
  try {
    const email = clean((req.body || {}).email, 160).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter the email address you registered with.' });
    const base = (process.env.SITE_URL || '').replace(/\/+$/, '');
    if (!base || !configured()) { console.error('Password reset not sent: SITE_URL or the SMTP settings are missing'); return reply(); }
    const [rows] = await pool.query('SELECT id, first_name FROM customers WHERE email = ?', [email]);
    if (!rows.length) return reply();
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('DELETE FROM password_resets WHERE customer_id = ?', [rows[0].id]);
    await pool.query('INSERT INTO password_resets (customer_id, token_hash, expires_at) VALUES (?, ?, ?)', [rows[0].id, sha(token), new Date(Date.now() + 60 * 60 * 1000)]);
    const link = base + '/index.html?reset=' + token;
    const name = escHtml(rows[0].first_name);
    await sendMail(email, 'Reset your Dewaswala Handicrafts password',
      `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#2a1a1d"><h2 style="color:#4a1420">Reset your password</h2><p>Hello ${name},</p><p>We received a request to reset the password for your Dewaswala Handicrafts account. Click the button below to choose a new one. The link works for 1 hour.</p><p><a href="${link}" style="display:inline-block;background:#4a1420;color:#fff;text-decoration:none;padding:12px 26px;border-radius:999px;font-weight:bold">Choose a new password</a></p><p style="font-size:13px;color:#7a6a6d">If you did not ask for this, you can ignore this email. Your password will not change.</p></div>`,
      `Hello ${rows[0].first_name},

Reset your Dewaswala Handicrafts password (link works for 1 hour):
${link}

If you did not ask for this, ignore this email.`);
    reply();
  } catch (e) { console.error('Forgot password failed:', e.message); reply(); }
});

router.post('/api/auth/reset', limited, async (req, res, next) => {
  try {
    const token = clean((req.body || {}).token, 100);
    const password = String((req.body || {}).password || '');
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    const [rows] = await pool.query('SELECT customer_id, expires_at FROM password_resets WHERE token_hash = ?', [sha(token)]);
    if (!token || !rows.length || new Date(rows[0].expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'This reset link has expired or was already used. Please ask for a new one.' });
    }
    await pool.query('UPDATE customers SET password_hash = ? WHERE id = ?', [await bcrypt.hash(password, 10), rows[0].customer_id]);
    await pool.query('DELETE FROM password_resets WHERE customer_id = ?', [rows[0].customer_id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// admin: list of registered customers
router.get('/api/admin/customers', requireAdmin, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT id, first_name, last_name, phone, email, company, gst, address, city, state, pin, created_at FROM customers ORDER BY id DESC');
    res.json(rows);
  } catch (e) { next(e); }
});

router.readProfile = readProfile;
module.exports = router;
