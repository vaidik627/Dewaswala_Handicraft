// Dewaswala Handicrafts: product API and admin panel
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const { makeToken, requireAdmin, optionalCustomer, SECRET } = require('./auth');
const cloud = require('./cloud');
const sizeOf = require('image-size');

const MAX_PHOTOS = 6;
// the category circle photo on the shop page: a square, 600 x 600 pixels is best (it is shown about 180 pixels wide)
const CIRCLE_MIN = 400;
function checkCirclePhoto(buffer) {
  let size;
  try { size = sizeOf(buffer); } catch (e) { size = null; }
  if (!size || !size.width || !size.height) return 'The photo could not be read. Please use a JPG, PNG or WebP file.';
  const ratio = size.width / size.height;
  if (ratio < 0.97 || ratio > 1.03) return 'The photo is ' + size.width + ' x ' + size.height + ' pixels. Please crop it to a square, for example 600 x 600 pixels, so it fits the circle without being cut off.';
  if (size.width < CIRCLE_MIN) return 'The photo is only ' + size.width + ' pixels wide. Please use at least ' + CIRCLE_MIN + ' x ' + CIRCLE_MIN + ' pixels. 600 x 600 is best.';
  return null;
}
// visitors who are not logged in see this many products in full; the rest are shown blurred
const GUEST_LIMIT = parseInt(process.env.GUEST_LIMIT, 10) || 8;

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
    const [rows] = await pool.query('SELECT slug, name, image_url FROM categories ORDER BY name');
    res.json(rows);
  } catch (e) { next(e); }
});

// the products a guest may see in full: taken one category at a time so every category shows up
async function guestSkus() {
  const [rows] = await pool.query('SELECT p.sku, p.category_id FROM products p ORDER BY p.id');
  const byCat = new Map();
  rows.forEach(r => { if (!byCat.has(r.category_id)) byCat.set(r.category_id, []); byCat.get(r.category_id).push(r.sku); });
  const lists = [...byCat.values()];
  const picked = new Set();
  for (let i = 0; picked.size < GUEST_LIMIT && lists.some(l => i < l.length); i++) {
    for (const l of lists) { if (i < l.length && picked.size < GUEST_LIMIT) picked.add(l[i]); }
  }
  return picked;
}

app.get('/api/products', optionalCustomer, async (req, res, next) => {
  try {
    const where = [];
    const args = [];
    if (req.query.category && req.query.category !== 'all') { where.push('c.slug = ?'); args.push(req.query.category); }
    if (req.query.q) { where.push('(p.name LIKE ? OR p.sku LIKE ?)'); args.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    const [rows] = await pool.query(`${PRODUCT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.id`, args);
    const products = await attachImages(rows);
    if (req.customerId) return res.json(products);
    // not logged in: a few products in full, the rest only as a blurred preview (no name, price or code)
    const open = await guestSkus();
    res.json(products.map(p => open.has(p.sku) ? p : {
      locked: true, category: p.category, category_slug: p.category_slug,
      images: p.images.length ? [{ url: p.images[0].url }] : []
    }));
  } catch (e) { next(e); }
});

app.get('/api/products/:sku', optionalCustomer, async (req, res, next) => {
  try {
    const [rows] = await pool.query(`${PRODUCT_SELECT} WHERE p.sku = ?`, [req.params.sku]);
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    if (!req.customerId && !(await guestSkus()).has(rows[0].sku)) {
      return res.status(401).json({ locked: true, error: 'Please log in or register to see this product.' });
    }
    res.json((await attachImages(rows))[0]);
  } catch (e) { next(e); }
});

// ---------- shop visitor accounts (see customers.js) ----------
app.use(require('./customers'));
app.use(require('./orders'));

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
      `SELECT c.id, c.slug, c.name, c.image_url, COUNT(p.id) AS product_count
       FROM categories c LEFT JOIN products p ON p.category_id = c.id
       GROUP BY c.id, c.slug, c.name, c.image_url ORDER BY c.name`
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
    const [img] = await pool.query('SELECT image_public_id FROM categories WHERE id = ?', [req.params.id]);
    if (img.length && img[0].image_public_id) await cloud.destroy(img[0].image_public_id).catch(() => {});
    await pool.query('DELETE FROM categories WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// the photo shown in this category's circle on the shop page (square, 600 x 600 pixels is best)
app.put('/api/admin/categories/:id/image', requireAdmin, upload.single('image'), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT slug, image_public_id FROM categories WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Category not found' });
    if (!req.file) return res.status(400).json({ error: 'Choose a photo (JPG, PNG or WebP, up to 8 MB).' });
    const problem = checkCirclePhoto(req.file.buffer);
    if (problem) return res.status(400).json({ error: problem });
    const result = await cloud.upload(req.file.buffer, 'dewaswala/category-circles/' + rows[0].slug);
    if (rows[0].image_public_id) await cloud.destroy(rows[0].image_public_id).catch(() => {});
    await pool.query('UPDATE categories SET image_url = ?, image_public_id = ? WHERE id = ?', [result.secure_url, result.public_id, req.params.id]);
    res.json({ ok: true, image_url: result.secure_url });
  } catch (e) { next(e); }
});

app.delete('/api/admin/categories/:id/image', requireAdmin, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT image_public_id FROM categories WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Category not found' });
    if (rows[0].image_public_id) await cloud.destroy(rows[0].image_public_id).catch(() => {});
    await pool.query('UPDATE categories SET image_url = NULL, image_public_id = NULL WHERE id = ?', [req.params.id]);
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
    if ((req.files || []).length > MAX_PHOTOS) return res.status(400).json({ error: 'A product can have up to ' + MAX_PHOTOS + ' photos. Please choose fewer.' });
    const [result] = await pool.query(
      `INSERT INTO products (sku, name, category_id, price, unit, size, color, description, best_seller, in_stock)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [f.sku, f.name, f.category_id, f.price, f.unit, f.size, f.color, f.description, f.best_seller, f.in_stock]
    );
    try {
      await storePhotos(result.insertId, f.sku, cat[0].slug, req.files || []);
    } catch (photoError) {
      // do not leave a product behind without its photos: remove it so the form can be submitted again
      const [saved] = await pool.query('SELECT public_id FROM product_images WHERE product_id = ?', [result.insertId]);
      for (const i of saved) { await cloud.destroy(i.public_id).catch(() => {}); }
      await pool.query('DELETE FROM products WHERE id = ?', [result.insertId]);
      console.error('Photo upload failed, product removed:', photoError.message || photoError);
      return res.status(502).json({ error: 'The photo could not be uploaded, so the product was not saved. Please try again.' });
    }
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
    const [[{ have }]] = await pool.query('SELECT COUNT(*) AS have FROM product_images WHERE product_id = ?', [req.params.id]);
    if (have + (req.files || []).length > MAX_PHOTOS) {
      return res.status(400).json({ error: 'A product can have up to ' + MAX_PHOTOS + ' photos. It has ' + have + ' now, so remove some first or add fewer.' });
    }
    await storePhotos(req.params.id, rows[0].sku, rows[0].slug, req.files || []);
    res.status(201).json({ ok: true, added: (req.files || []).length });
  } catch (e) { next(e); }
});

// make one photo the main photo (shown first on the shop and product page)
app.put('/api/admin/images/:id/main', requireAdmin, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT product_id FROM product_images WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Photo not found' });
    const productId = rows[0].product_id;
    const [all] = await pool.query('SELECT id FROM product_images WHERE product_id = ? ORDER BY position, id', [productId]);
    const order = [Number(req.params.id)].concat(all.map(r => r.id).filter(id => id !== Number(req.params.id)));
    for (let i = 0; i < order.length; i++) {
      await pool.query('UPDATE product_images SET position = ? WHERE id = ?', [i, order[i]]);
    }
    res.json({ ok: true });
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

// ---------- homepage slider (see slider.js) ----------
require('./slider')(app, { pool, requireAdmin, upload, cloud });

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
  // the shop-page circle photo of each category (added to tables made before this feature)
  for (const col of ['image_url VARCHAR(500) NULL', 'image_public_id VARCHAR(255) NULL']) {
    try { await pool.query('ALTER TABLE categories ADD COLUMN ' + col); }
    catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
  }

  // One-time: with SEED_CATEGORY_IMAGES=true, give the categories in seed/category-images.json their circle photo (only if they have none yet)
  if (process.env.SEED_CATEGORY_IMAGES === 'true') {
    const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', 'category-images.json'), 'utf8'));
    for (const item of items) {
      await pool.query('INSERT IGNORE INTO categories (slug, name) VALUES (?, ?)', [slugify(item.category), item.category]);
      const [cat] = await pool.query('SELECT id, slug, image_url FROM categories WHERE name = ?', [item.category]);
      if (!cat.length) { console.error('Seed: category not found:', item.category); continue; }
      if (cat[0].image_url) { console.log('Seed: circle photo already set for', item.category); continue; }
      const result = await cloud.upload(fs.readFileSync(path.join(__dirname, item.image)), 'dewaswala/category-circles/' + cat[0].slug);
      await pool.query('UPDATE categories SET image_url = ?, image_public_id = ? WHERE id = ?', [result.secure_url, result.public_id, cat[0].id]);
      console.log('Seeded circle photo for', item.category);
    }
  }

  // One-time: with REMOVE_SAMPLE_PRODUCTS=true, delete the old sample products (codes ML-001 ... ML-999 and FL-001) with their photos
  if (process.env.REMOVE_SAMPLE_PRODUCTS === 'true') {
    const [old] = await pool.query("SELECT id, sku FROM products WHERE sku REGEXP '^ML-[0-9]{3}$' OR sku = 'FL-001'");
    for (const prod of old) {
      const [imgs] = await pool.query('SELECT public_id FROM product_images WHERE product_id = ?', [prod.id]);
      for (const i of imgs) { await cloud.destroy(i.public_id).catch(() => {}); }
      await pool.query('DELETE FROM products WHERE id = ?', [prod.id]);
    }
    console.log('Old sample products removed:', old.length);
  }

  // One-time: with SEED_PRODUCTS=true, add the products in seed/products.json that don't exist yet (photo goes to Cloudinary)
  if (process.env.SEED_PRODUCTS === 'true') {
    const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', 'products.json'), 'utf8'));
    for (const item of items) {
      const files = item.images && item.images.length ? item.images : [item.image];
      const [cat] = await pool.query('SELECT id, slug FROM categories WHERE name = ?', [item.category]);
      if (!cat.length) { console.error('Seed: category not found:', item.category); continue; }
      let productId;
      const [exists] = await pool.query('SELECT id FROM products WHERE sku = ?', [item.sku]);
      if (exists.length) {
        productId = exists[0].id;
      } else {
        const [ins] = await pool.query(
          'INSERT INTO products (sku, name, category_id, price, unit, size, color, description, best_seller, in_stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
          [item.sku, item.name, cat[0].id, item.price, item.unit || 'per pc', item.size || null, item.color || null, item.description || null, item.best_seller ? 1 : 0]
        );
        productId = ins.insertId;
      }
      // add only the photos the product does not have yet (so a restart never duplicates photos)
      const [[{ have }]] = await pool.query('SELECT COUNT(*) AS have FROM product_images WHERE product_id = ?', [productId]);
      for (let i = have; i < Math.min(files.length, MAX_PHOTOS); i++) {
        const file = fs.readFileSync(path.join(__dirname, files[i]));
        const result = await cloud.upload(file, 'dewaswala/' + cat[0].slug + '/' + item.sku);
        await pool.query('INSERT INTO product_images (product_id, url, public_id, position) VALUES (?, ?, ?, ?)', [productId, result.secure_url, result.public_id, i]);
      }
      console.log('Seeded product', item.sku, '- photos:', Math.min(files.length, MAX_PHOTOS));
    }
  }

  // One-time: with SEED_CATEGORIES=true, add the categories in categories.json that don't exist yet
  if (process.env.SEED_CATEGORIES === 'true') {
    const names = JSON.parse(fs.readFileSync(path.join(__dirname, 'categories.json'), 'utf8'));
    for (const name of names) {
      await pool.query('INSERT IGNORE INTO categories (slug, name) VALUES (?, ?)', [slugify(name), name]);
    }
    console.log('Categories added from categories.json:', names.length);
  }

  // One-time: with DEDUPE_PHOTOS=true, keep one photo per position for every product and delete the extra copies
  if (process.env.DEDUPE_PHOTOS === 'true') {
    const [imgs] = await pool.query('SELECT id, product_id, position, public_id FROM product_images ORDER BY product_id, position, id');
    const seen = new Set();
    let removed = 0;
    for (const img of imgs) {
      const key = img.product_id + ':' + img.position;
      if (!seen.has(key)) { seen.add(key); continue; }
      await cloud.destroy(img.public_id).catch(() => {});
      await pool.query('DELETE FROM product_images WHERE id = ?', [img.id]);
      removed++;
    }
    console.log('Duplicate photos removed:', removed);
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
