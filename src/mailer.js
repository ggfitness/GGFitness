// Envío de mails con 3 modos (se elige automáticamente):
//   1) Resend API   -> si hay RESEND_API_KEY  (recomendado en Vercel)
//   2) SMTP          -> si hay SMTP_HOST/USER/PASS (Gmail, etc.)
//   3) Demo (consola)-> si no hay nada configurado (para probar)
const nodemailer = require('nodemailer');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM =
  process.env.MAIL_FROM ||
  process.env.SMTP_FROM ||
  'Personal Trainer <onboarding@resend.dev>';

let transporter = null;
let mode = 'demo';

if (RESEND_API_KEY) {
  mode = 'resend';
  console.log('✉️  Envío de mails: Resend API (real).');
} else if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mode = 'smtp';
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  console.log('✉️  Envío de mails: SMTP (real).');
} else {
  console.log('✉️  Envío de mails: modo demo (se muestran en la consola).');
}

async function sendMail({ to, subject, html, text }) {
  // 1) Resend API
  if (mode === 'resend') {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to, subject, html, text }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resend respondió ${res.status}: ${detail}`);
    }
    return res.json();
  }

  // 2) SMTP
  if (mode === 'smtp') {
    return transporter.sendMail({ from: FROM, to, subject, html, text });
  }

  // 3) Demo (consola)
  console.log('\n================= 📧 MAIL (demo) =================');
  console.log('Para:    ', to);
  console.log('Asunto:  ', subject);
  console.log('Contenido:\n', text || html);
  console.log('=================================================\n');
  return { demo: true };
}

module.exports = { sendMail };
