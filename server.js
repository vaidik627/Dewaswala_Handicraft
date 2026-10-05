// Dewaswala Handicrafts: product API and admin panel
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const { makeToken, requireAdmin, SECRET } = require('./auth');
const cloud = require('./cloud');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype))
});

const PRODUCT_SELECT = `SELECT p.id, p.sku, p.name, p.category_id, c.name AS category, c.slug AS category_slug,
  p.price, p.unit, p.size, p.color, p.description, p.best_seller, p.in_stock
  FROM products p JOIN categories c ON c.id = p.category_id`;

function slugify(text) {
  return text.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-') || 'category';
}

async function attachImages(products) {
  if (!products.length) return products;
  const [imgs] = await pool.query(
    'SELECT id, product_id, url, public_id FROM product_images WHERE product_id IN (?) ORDER BY position, id',
    [products.map(p => p.id)]
  );
  const byProduct = {};
  imgs.forEach(i => { (byProduct[i.product_id] = byProduct[i.product_id] || []).push({ id: i.id, url: i.url, public_id: i.public_id }); });
  products.forEach(p => { p.images = byProduct[p.id] || []; });
  return products;
}

function productFields(body) {
  const price = parseInt(body.price, 10);
  const categoryId = parseInt(body.category_id, 10);
  if (!body.sku || !body.name || !categoryId || !(price > 0)) return null;
  return {
    sku: String(body.sku).trim(),
    name: String(body.name).trim(),
    category_id: categoryId,
    price,
    unit: body.unit ? String(body.unit).trim() : 'per pc',
    size: body.size ? String(body.size).trim() : null,
    color: body.color ? String(body.color).trim() : null,
    description: body.description ? String(body.description).trim() : null,
    best_seller: body.best_seller === '1' || body.best_seller === true || body.best_seller === 'true' ? 1 : 0,
    in_stock: body.in_stock === '0' || body.in_stock === false || body.in_stock === 'false' ? 0 : 1
  };
}

// ---------- public (used by the shop) ----------

app.get('/', (req, res) => res.json({ ok: true, service: 'dewaswala-api' }));
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/health/db', async (req, res, next) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, database: process.env.DB_NAME }); } catch (e) { next(e); }
});

app.get('/api/categories', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT slug, name FROM categories ORDER BY name');
    res.json(rows);
  } catch (e) { next(e); }
});

app.get('/api/products', async (req, res, next) => {
  try {
    const where = [];
    const args = [];
    if (req.query.category && req.query.category !== 'all') { where.push('c.slug = ?'); args.push(req.query.category); }
    if (req.query.q) { where.push('(p.name LIKE ? OR p.sku LIKE ?)'); args.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    const [rows] = await pool.query(`${PRODUCT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.id`, args);
    res.json(await attachImages(rows));
  } catch (e) { next(e); }
});

app.get('/api/products/:sku', async (req, res, next) => {
  try {
    const [rows] = await pool.query(`${PRODUCT_SELECT} WHERE p.sku = ?`, [req.params.sku]);
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json((await attachImages(rows))[0]);
  } catch (e) { next(e); }
});

// ---------- admin login ----------

app.post('/api/admin/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const [rows] = await pool.query('SELECT username, password_hash FROM admins WHERE username = ?', [username || '']);
    if (!rows.length || !(await bcrypt.compare(password || '', rows[0].password_hash))) {
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    res.json({ token: makeToken(username) });
  } catch (e) { next(e); }
});

// ---------- admin: categories ----------

app.get('/api/admin/categories', requireAdmin, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.id, c.slug, c.name, COUNT(p.id) AS product_count
       FROM categories c LEFT JOIN products p ON p.category_id = c.id
       GROUP BY c.id, c.slug, c.name ORDER BY c.name`
    );
    res.json(rows);
  } catch (e) { next(e); }
});

app.post('/api/admin/categories', requireAdmin, async (req, res, next) => {
  try {
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: 'Category name is required' });
    const [result] = await pool.query('INSERT INTO categories (slug, name) VALUES (?, ?)', [slugify(name), name]);
    res.status(201).json({ id: result.insertId, name });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A category with this name already exists' });
    next(e);
  }
});

app.put('/api/admin/categories/:id', requireAdmin, async (req, res, next) => {
  try {
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: 'Category name is required' });
    await pool.query('UPDATE categories SET name = ? WHERE id = ?', [name, req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.delete('/api/admin/categories/:id', requireAdmin, async (req, res, next) => {
  try {
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM products WHERE category_id = ?', [req.params.id]);
    if (n > 0) return res.status(409).json({ error: 'This category still has products. Delete or move them first.' });
    await pool.query('DELETE FROM categories WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- admin: products ----------

app.get('/api/admin/products', requireAdmin, async (req, res, next) => {
  try {
    const args = [];
    let where = '';
    if (req.query.category_id) { where = 'WHERE p.category_id = ?'; args.push(req.query.category_id); }
    const [rows] = await pool.query(`${PRODUCT_SELECT} ${where} ORDER BY p.id`, args);
    res.json(await attachImages(rows));
  } catch (e) { next(e); }
});

async function storePhotos(productId, sku, categorySlug, files) {
  let position = 0;
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?', [productId]);
  position = n;
  for (const file of files) {
    const result = await cloud.upload(file.buffer, `dewaswala/${categorySlug}/${sku}`);
    await pool.query(
      'INSERT INTO product_images (product_id, url, public_id, position) VALUES (?, ?, ?, ?)',
      [productId, result.secure_url, result.public_id, position++]
    );
  }
}

app.post('/api/admin/products', requireAdmin, upload.array('images', 8), async (req, res, next) => {
  try {
    const f = productFields(req.body || {});
    if (!f) return res.status(400).json({ error: 'SKU, name, category, and a price above 0 are required' });
    const [cat] = await pool.query('SELECT slug FROM categories WHERE id = ?', [f.category_id]);
    if (!cat.length) return res.status(400).json({ error: 'Choose a valid category' });
    const [result] = await pool.query(
      `INSERT INTO products (sku, name, category_id, price, unit, size, color, description, best_seller, in_stock)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [f.sku, f.name, f.category_id, f.price, f.unit, f.size, f.color, f.description, f.best_seller, f.in_stock]
    );
    await storePhotos(result.insertId, f.sku, cat[0].slug, req.files || []);
    res.status(201).json({ id: result.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This product code (SKU) is already used' });
    next(e);
  }
});

app.put('/api/admin/products/:id', requireAdmin, async (req, res, next) => {
  try {
    const f = productFields(req.body || {});
    if (!f) return res.status(400).json({ error: 'SKU, name, category, and a price above 0 are required' });
    await pool.query(
      `UPDATE products SET sku=?, name=?, category_id=?, price=?, unit=?, size=?, color=?, description=?, best_seller=?, in_stock=?
       WHERE id=?`,
      [f.sku, f.name, f.category_id, f.price, f.unit, f.size, f.color, f.description, f.best_seller, f.in_stock, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This product code (SKU) is already used' });
    next(e);
  }
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res, next) => {
  try {
    const [imgs] = await pool.query('SELECT public_id FROM product_images WHERE product_id = ?', [req.params.id]);
    for (const i of imgs) { await cloud.destroy(i.public_id).catch(() => {}); }
    await pool.query('DELETE FROM products WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/admin/products/:id/images', requireAdmin, upload.array('images', 8), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT p.sku, c.slug FROM products p JOIN categories c ON c.id = p.category_id WHERE p.id = ?', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    await storePhotos(req.params.id, rows[0].sku, rows[0].slug, req.files || []);
    res.status(201).json({ ok: true, added: (req.files || []).length });
  } catch (e) { next(e); }
});

app.delete('/api/admin/images/:id', requireAdmin, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT public_id FROM product_images WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Photo not found' });
    await cloud.destroy(rows[0].public_id).catch(() => {});
    await pool.query('DELETE FROM product_images WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- admin page ----------

const adminPage = path.join(__dirname, 'public', 'admin', 'index.html');
app.get(['/admin', '/admin/'], (req, res, next) => {
  if (!fs.existsSync(adminPage)) return res.status(500).send('Admin page file is missing on the server: public/admin/index.html');
  res.sendFile(adminPage);
});
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));

// ---------- errors ----------

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Photo upload failed: ' + err.message });
  console.error(err);
  res.status(500).json({ error: 'Server error. Please try again.' });
});

// ---------- startup: create missing tables and the admin login ----------

async function setup() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    await pool.query(stmt);
  }
  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASSWORD;
  if (user && pass) {
    await pool.query(
      'INSERT INTO admins (username, password_hash) VALUES (?, ?) ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)',
      [user, await bcrypt.hash(pass, 10)]
    );
  }
}

setup()
  .then(() => console.log('Database ready'))
  .catch(e => console.error('Database setup failed:', e.message));

if (!SECRET) console.warn('SESSION_SECRET is not set: admin login is disabled');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Dewaswala API listening on', PORT));
