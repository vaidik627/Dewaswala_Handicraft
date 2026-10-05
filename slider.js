// Homepage slider: public read, admin add / edit / reorder / hide / delete
const sizeOf = require('image-size');

module.exports = function registerSlider(app, { pool, requireAdmin, upload, cloud }) {
  const FOLDER = 'dewaswala/homepage-slider';
  const LIMITS = { eyebrow: 120, headline: 200, text: 400, button_label: 60, button_link: 300 };

  // Photo rule for the homepage slider: at least 1600 px wide and close to 2:1 (2000 x 1000 is best)
  function checkSlidePhoto(buffer) {
    let size;
    try { size = sizeOf(buffer); } catch (e) { size = null; }
    if (!size || !size.width || !size.height) return 'The photo could not be read. Please use a JPG, PNG or WebP file.';
    if (size.width < 1600) return 'The photo is ' + size.width + ' pixels wide. Please use at least 1600 pixels wide. 2000 x 1000 pixels is best.';
    const ratio = size.width / size.height;
    if (ratio < 1.9 || ratio > 2.1) return 'The photo is ' + size.width + ' x ' + size.height + ' pixels. Please crop it to 2:1, for example 2000 x 1000 pixels, so it fills the slider without being cut off.';
    return null;
  }

  function slideFields(body) {
    const out = {};
    for (const [key, max] of Object.entries(LIMITS)) {
      out[key] = body[key] ? String(body[key]).trim().slice(0, max) : null;
    }
    if (!out.headline) return null;
    out.active = body.active === '0' || body.active === false || body.active === 'false' ? 0 : 1;
    return out;
  }

  // Public: only the active slides, in order
  app.get('/api/hero-slides', async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        'SELECT id, image_url, eyebrow, headline, text, button_label, button_link FROM hero_slides WHERE active = 1 ORDER BY position, id'
      );
      res.json(rows);
    } catch (e) { next(e); }
  });

  // Admin: all slides
  app.get('/api/admin/hero-slides', requireAdmin, async (req, res, next) => {
    try {
      const [rows] = await pool.query('SELECT * FROM hero_slides ORDER BY position, id');
      res.json(rows);
    } catch (e) { next(e); }
  });

  // Admin: add a slide (photo is required)
  app.post('/api/admin/hero-slides', requireAdmin, upload.single('image'), async (req, res, next) => {
    try {
      const f = slideFields(req.body || {});
      if (!f) return res.status(400).json({ error: 'The headline is required' });
      if (!req.file) return res.status(400).json({ error: 'Choose a photo for the slide' });
      const photoProblem = checkSlidePhoto(req.file.buffer);
      if (photoProblem) return res.status(400).json({ error: photoProblem });
      const result = await cloud.upload(req.file.buffer, FOLDER);
      const [[{ nextPos }]] = await pool.query('SELECT COALESCE(MAX(position), 0) + 1 AS nextPos FROM hero_slides');
      const [ins] = await pool.query(
        'INSERT INTO hero_slides (image_url, public_id, eyebrow, headline, text, button_label, button_link, position, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [result.secure_url, result.public_id, f.eyebrow, f.headline, f.text, f.button_label, f.button_link, nextPos, f.active]
      );
      res.status(201).json({ id: ins.insertId });
    } catch (e) { next(e); }
  });

  // Admin: edit text, visibility, order, and optionally replace the photo
  app.put('/api/admin/hero-slides/:id', requireAdmin, upload.single('image'), async (req, res, next) => {
    try {
      const f = slideFields(req.body || {});
      if (!f) return res.status(400).json({ error: 'The headline is required' });
      const [rows] = await pool.query('SELECT public_id FROM hero_slides WHERE id = ?', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Slide not found' });
      await pool.query(
        'UPDATE hero_slides SET eyebrow = ?, headline = ?, text = ?, button_label = ?, button_link = ?, active = ? WHERE id = ?',
        [f.eyebrow, f.headline, f.text, f.button_label, f.button_link, f.active, req.params.id]
      );
      if (req.body && req.body.position !== undefined && req.body.position !== '') {
        await pool.query('UPDATE hero_slides SET position = ? WHERE id = ?', [parseInt(req.body.position, 10) || 0, req.params.id]);
      }
      if (req.file) {
        const photoProblem = checkSlidePhoto(req.file.buffer);
        if (photoProblem) return res.status(400).json({ error: photoProblem });
        const result = await cloud.upload(req.file.buffer, FOLDER);
        await cloud.destroy(rows[0].public_id).catch(() => {});
        await pool.query('UPDATE hero_slides SET image_url = ?, public_id = ? WHERE id = ?', [result.secure_url, result.public_id, req.params.id]);
      }
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Admin: delete a slide and its photo
  app.delete('/api/admin/hero-slides/:id', requireAdmin, async (req, res, next) => {
    try {
      const [rows] = await pool.query('SELECT public_id FROM hero_slides WHERE id = ?', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Slide not found' });
      await cloud.destroy(rows[0].public_id).catch(() => {});
      await pool.query('DELETE FROM hero_slides WHERE id = ?', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
};
