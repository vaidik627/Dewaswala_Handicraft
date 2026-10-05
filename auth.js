// Admin login tokens. A token is signed with SESSION_SECRET (kept in the hosting settings) and expires after 12 hours.
const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET || '';

function sign(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
}

function makeToken(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + 12 * 60 * 60 * 1000 })).toString('base64url');
  return payload + '.' + sign(payload);
}

function readToken(token) {
  if (!SECRET || !token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || sign(payload) !== sig) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data.u : null;
  } catch (e) {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const user = readToken((req.headers.authorization || '').replace(/^Bearer /, ''));
  if (!user) return res.status(401).json({ error: 'Please log in again' });
  req.admin = user;
  next();
}

module.exports = { makeToken, requireAdmin, SECRET };
