// Order messages for the client's WhatsApp: the text itself, the wa.me link, and the WhatsApp Business Cloud API sender.
// Secrets: WA_NOTIFY_TO (client number, digits with country code, e.g. 917049902595),
//          WA_TOKEN + WA_PHONE_NUMBER_ID (WhatsApp Cloud API), optional WA_TEMPLATE_NAME + WA_TEMPLATE_LANG.

const rupees = n => '₹' + Number(n).toLocaleString('en-IN');
const LINE = '━━━━━━━━━━━━━━━━━━';

function istTime(d) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(d);
}

function prettyPhone(p) { return String(p).replace(/^(\d{5})(\d{5})$/, '$1 $2'); }

// The message the client's team reads. WhatsApp shows *text* in bold.
function buildMessage(o) {
  const pcs = o.items.reduce((s, i) => s + i.qty, 0);
  const lines = [];
  lines.push('🛍️ *NEW ORDER*');
  lines.push('*Order No:* ' + o.orderNo);
  lines.push('*Date:* ' + istTime(o.createdAt));
  lines.push(LINE);
  lines.push('');
  lines.push('👤 *CUSTOMER*');
  lines.push('Name: ' + o.name);
  if (o.company) lines.push('Shop: ' + o.company);
  lines.push('Mobile: ' + prettyPhone(o.phone));
  lines.push('Email: ' + o.email);
  if (o.gst) lines.push('GST: ' + o.gst);
  lines.push('');
  lines.push('📍 *DELIVERY ADDRESS*');
  lines.push(o.address);
  lines.push(o.city + ', ' + o.state + ' - ' + o.pin);
  lines.push('');
  lines.push('📦 *ITEMS* (' + o.items.length + ' product' + (o.items.length > 1 ? 's' : '') + ', ' + pcs + ' pcs)');
  lines.push(LINE);
  o.items.forEach((i, n) => {
    lines.push((n + 1) + '. *' + i.name + '*');
    lines.push('    Code: ' + i.sku);
    lines.push('    ' + rupees(i.price) + ' × ' + i.qty + ' = *' + rupees(i.price * i.qty) + '*');
    if (n < o.items.length - 1) lines.push('');
  });
  lines.push(LINE);
  lines.push('💰 *TOTAL: ' + rupees(o.total) + '*');
  lines.push('_(before GST, delivery charges extra)_');
  if (o.note) { lines.push(''); lines.push('📝 *Customer note:*'); lines.push(o.note); }
  lines.push('');
  lines.push('➡️ Please call or WhatsApp the customer to confirm this order.');
  return lines.join('\n');
}

function notifyNumber() { return String(process.env.WA_NOTIFY_TO || '917049902595').replace(/\D/g, ''); }

function waLink(text) { return 'https://wa.me/' + notifyNumber() + '?text=' + encodeURIComponent(text); }

async function graph(body) {
  const res = await fetch('https://graph.facebook.com/v20.0/' + process.env.WA_PHONE_NUMBER_ID + '/messages', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.WA_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ messaging_product: 'whatsapp', to: notifyNumber() }, body)),
    signal: AbortSignal.timeout(10000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error((data.error && data.error.message) || 'WhatsApp error ' + res.status); e.code = data.error && data.error.code; throw e; }
  return data;
}

const oneLine = t => String(t).replace(/[\r\n\t]+/g, ' | ').replace(/ {2,}/g, ' ').trim().slice(0, 900);

// Sends the order to the client's WhatsApp. Returns true when WhatsApp accepted it.
// A normal text works while the client's number has chatted with the business number in the last 24 hours;
// otherwise the approved template (WA_TEMPLATE_NAME) is used, if one is set up.
async function sendOrder(o, text) {
  if (!process.env.WA_TOKEN || !process.env.WA_PHONE_NUMBER_ID) return false;
  try {
    await graph({ type: 'text', text: { body: text, preview_url: false } });
    return true;
  } catch (e) {
    console.error('WhatsApp text failed:', e.message);
    if (!process.env.WA_TEMPLATE_NAME) return false;
  }
  try {
    const items = o.items.map(i => i.name + ' (' + i.sku + ') x' + i.qty + ' = ' + rupees(i.price * i.qty)).join(' | ');
    await graph({
      type: 'template',
      template: {
        name: process.env.WA_TEMPLATE_NAME, language: { code: process.env.WA_TEMPLATE_LANG || 'en' },
        components: [{ type: 'body', parameters: [
          o.orderNo,
          o.name + ', ' + prettyPhone(o.phone) + (o.company ? ', ' + o.company : ''),
          o.address + ', ' + o.city + ', ' + o.state + ' - ' + o.pin,
          items,
          rupees(o.total)
        ].map(t => ({ type: 'text', text: oneLine(t) })) }]
      }
    });
    return true;
  } catch (e) {
    console.error('WhatsApp template failed:', e.message);
    return false;
  }
}

module.exports = { buildMessage, waLink, sendOrder };
