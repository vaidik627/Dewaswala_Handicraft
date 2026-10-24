// Orders: placed from the cart by a logged-in customer, saved, then sent to the client's WhatsApp
const express = require('express');
const pool = require('./db');
const { requireCustomer, requireAdmin } = require('./auth');
const { readProfile } = require('./customers');
const wa = require('./whatsapp');

const router = express.Router();
const MAX_LINES = 60;

router.post('/api/orders', requireCustomer, async (req, res, next) => {
  try {
    const body = req.body || {};
    const { d, error } = readProfile(body.details || {}, true);
    if (error) return res.status(400).json({ error });
    const lines = Array.isArray(body.items) ? body.items.slice(0, MAX_LINES) : [];
    const qtyBySku = new Map();
    for (const l of lines) {
      const qty = parseInt(l && l.qty, 10);
      const sku = l && String(l.sku || '').trim();
      if (!sku || !(qty >= 1 && qty <= 9999)) return res.status(400).json({ error: 'Your cart has an item with a wrong quantity. Please check the cart.' });
      qtyBySku.set(sku, (qtyBySku.get(sku) || 0) + qty);
    }
    if (!qtyBySku.size) return res.status(400).json({ error: 'Your cart is empty.' });

    // prices and names always come from the database, never from the browser
    const [prods] = await pool.query('SELECT sku, name, price FROM products WHERE sku IN (?) AND in_stock = 1', [[...qtyBySku.keys()]]);
    const found = new Map(prods.map(p => [p.sku, p]));
    const missing = [...qtyBySku.keys()].filter(s => !found.has(s));
    if (missing.length) return res.status(400).json({ error: 'Some products in your cart are no longer available (' + missing.join(', ') + '). Please remove them and try again.' });
    const items = [...qtyBySku].map(([sku, qty]) => ({ sku, name: found.get(sku).name, price: found.get(sku).price, qty }));
    const total = items.reduce((s, i) => s + i.price * i.qty, 0);
    const note = body.note ? String(body.note).trim().slice(0, 500) : null;

    const [ins] = await pool.query(
      `INSERT INTO orders (customer_id, customer_name, phone, email, company, gst, address, city, state, pin, note, items, total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.customerId, d.first_name + ' ' + d.last_name, d.phone, d.email, d.company, d.gst, d.address, d.city, d.state, d.pin, note, JSON.stringify(items), total]
    );
    const now = new Date();
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: '2-digit', month: '2-digit', day: '2-digit' }).format(now).replace(/-/g, '');
    const orderNo = 'DH-' + ymd + '-' + String(ins.insertId).padStart(4, '0');
    await pool.query('UPDATE orders SET order_no = ? WHERE id = ?', [orderNo, ins.insertId]);

    const order = { orderNo, createdAt: now, name: d.first_name + ' ' + d.last_name, company: d.company, phone: d.phone, email: d.email, gst: d.gst,
      address: d.address, city: d.city, state: d.state, pin: d.pin, items, total, note };
    const text = wa.buildMessage(order);
    const sent = await wa.sendOrder(order, text);
    if (sent) await pool.query('UPDATE orders SET wa_sent = 1 WHERE id = ?', [ins.insertId]);
    // if the server could not send it, the shop offers a one-tap WhatsApp button with the same message
    res.json({ orderNo, total, items, sent, waLink: sent ? null : wa.waLink(text) });
  } catch (e) { next(e); }
});

const shape = r => ({ orderNo: r.order_no, total: r.total, items: JSON.parse(r.items), note: r.note, createdAt: r.created_at,
  address: [r.address, r.city, r.state, r.pin].filter(Boolean).join(', ') });

router.get('/api/orders', requireCustomer, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 100', [req.customerId]);
    res.json(rows.map(shape));
  } catch (e) { next(e); }
});

router.get('/api/admin/orders', requireAdmin, async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM orders ORDER BY id DESC LIMIT 500');
    res.json(rows.map(r => Object.assign(shape(r), { name: r.customer_name, phone: r.phone, email: r.email, company: r.company, gst: r.gst, waSent: !!r.wa_sent })));
  } catch (e) { next(e); }
});

module.exports = router;
