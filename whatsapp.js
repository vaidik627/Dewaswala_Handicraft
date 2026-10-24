// Order messages for the client's WhatsApp: the text itself, the wa.me link, and the WhatsApp Business Cloud API sender.
// Secrets: WA_NOTIFY_TO (client number, digits with country code, e.g. 917049902595),
//          WA_TOKEN + WA_PHONE_NUMBER_ID (WhatsApp Cloud API), optional WA_TEMPLATE_NAME + WA_TEMPLATE_LANG.

const rupees = n => '₹' + Number(n).toLocaleString('en-IN');
const LINE = '==============================';

function istTime(d) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(d);
}

function prettyPhone(p) { return String(p).replace(/^(\d{5})(\d{5})$/, '$1 $2'); }

// The message the client's team reads. WhatsApp shows *text* in bold.
// Only plain characters (no emoji), so it looks the same on every phone and nothing turns into a "?" box.
function buildMessage(o) {
  const pcs = o.items.reduce((s, i) => s + i.qty, 0);
  const L = [];
  L.push('*NEW ORDER*  -  ' + o.orderNo);
  L.push(istTime(o.createdAt));
  L.push(LINE);
  L.push('*CUSTOMER*');
  L.push('Name: ' + o.name);
  if (o.company) L.push('Shop: ' + o.company);
  L.push('Mobile: +91 ' + prettyPhone(o.phone));
  L.push('Email: ' + o.email);
  if (o.gst) L.push('GST: ' + o.gst);
  L.push('');
  L.push('*DELIVERY ADDRESS*');
  L.push(o.address);
  L.push(o.city + ', ' + o.state + ' - ' + o.pin);
  L.push(LINE);
  L.push('*ITEMS*  (' + o.items.length + ' product' + (o.items.length > 1 ? 's' : '') + ', ' + pcs + ' pcs)');
  L.push('');
  o.items.forEach((i, n) => {
    L.push((n + 1) + ') *' + i.name + '*');
    L.push('     Code: ' + i.sku);
    L.push('     ' + rupees(i.price) + ' x ' + i.qty + ' = *' + rupees(i.price * i.qty) + '*');
    L.push('');
  });
  L.push(LINE);
  L.push('*TOTAL: ' + rupees(o.total) + '*');
  L.push('(Before GST. Delivery charges extra)');
  if (o.note) { L.push(''); L.push('*Customer note:* ' + o.note); }
  L.push(LINE);
  L.push('Please call the customer to confirm this order.');
  return L.join('\n');
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
