// Sends emails (password reset). Needs SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM in the hosting secrets.
const nodemailer = require('nodemailer');

function configured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transport = null;
function getTransport() {
  if (!transport) {
    const port = parseInt(process.env.SMTP_PORT, 10) || 465;
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  }
  return transport;
}

async function sendMail(to, subject, html, text) {
  if (!configured()) throw new Error('Email is not set up (SMTP_HOST, SMTP_USER, SMTP_PASS missing)');
  await getTransport().sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, html, text });
}

module.exports = { sendMail, configured };
