// Emails the generated PDF to the admin (Gmail or any SMTP server).
// Small built-in SMTP client: no extra npm package needed.
//   Gmail: SMTP_HOST=smtp.gmail.com, SMTP_PORT=465, SMTP_USER=you@gmail.com, SMTP_PASS=<16-letter App Password>
const tls = require('tls');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { list } = require('./env');

const MAX_ATTACH_BYTES = 18 * 1024 * 1024; // Gmail limit is 25 MB after encoding

function cfg() {
  const port = Number(process.env.SMTP_PORT || 465);
  return {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    user: process.env.SMTP_USER || '',
    pass: (process.env.SMTP_PASS || '').replace(/\s+/g, ''), // Google shows app passwords with spaces
    fromName: process.env.MAIL_FROM_NAME || 'UrCare Onboarding',
    admins: list(process.env.ADMIN_EMAIL),
    toEmployee: process.env.EMAIL_TO_EMPLOYEE === 'true',
  };
}

function isConfigured() {
  const c = cfg();
  return Boolean(c.user && c.pass && c.admins.length);
}

const maskEmail = (e) => {
  const [u, d] = String(e).split('@');
  if (!d) return e;
  return `${u.slice(0, 2)}${'*'.repeat(Math.max(1, u.length - 2))}@${d}`;
};

// ---------- tiny SMTP session ----------
class Session {
  constructor(socket) {
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    this.buffer = '';
    this.waiter = null;
    this.lines = [];
    socket.setEncoding('utf8');
    socket.on('data', (d) => { this.buffer += d; this.drain(); });
    socket.on('error', (e) => this.fail(e));
    socket.on('close', () => this.fail(new Error('SMTP connection closed')));
  }

  detach() {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('close');
  }

  fail(err) {
    if (this.waiter) { const w = this.waiter; this.waiter = null; w.reject(err); }
    this.error = this.error || err;
  }

  drain() {
    let i;
    while ((i = this.buffer.indexOf('\r\n')) !== -1) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 2);
      this.lines.push(line);
      // Final line of a reply is "123 text" (a dash after the code means more lines follow)
      if (/^\d{3}(?: |$)/.test(line) && this.waiter) {
        const reply = { code: Number(line.slice(0, 3)), text: this.lines.join('\n') };
        this.lines = [];
        const w = this.waiter;
        this.waiter = null;
        w.resolve(reply);
      }
    }
  }

  read(expect) {
    return new Promise((resolve, reject) => {
      if (this.error) return reject(this.error);
      this.waiter = {
        resolve: (r) => (expect.includes(r.code) ? resolve(r) : reject(new Error(`SMTP ${r.code}: ${r.text.replace(/\n/g, ' ')}`))),
        reject,
      };
      this.drain();
    });
  }

  async cmd(line, expect) {
    this.socket.write(`${line}\r\n`);
    return this.read(expect);
  }
}

function connect(c) {
  return new Promise((resolve, reject) => {
    const opts = { host: c.host, port: c.port, servername: c.host };
    const socket = c.secure ? tls.connect(opts) : net.connect(opts);
    socket.setTimeout(30000, () => socket.destroy(new Error('SMTP timed out')));
    socket.once(c.secure ? 'secureConnect' : 'connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function upgradeToTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host }, () => resolve(secure));
    secure.setTimeout(30000, () => secure.destroy(new Error('SMTP timed out')));
    secure.once('error', reject);
  });
}

// ---------- MIME ----------
const b64Lines = (buf) => buf.toString('base64').replace(/.{1,76}/g, '$&\r\n');
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

function buildMessage({ from, fromName, to, subject, text, html, attachment }) {
  const mixed = `mix_${crypto.randomBytes(8).toString('hex')}`;
  const alt = `alt_${crypto.randomBytes(8).toString('hex')}`;
  const domain = from.split('@')[1] || 'localhost';
  const parts = [
    `From: ${encWord(fromName)} <${from}>`,
    `To: ${to.join(', ')}`,
    `Subject: ${encWord(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(Buffer.from(text)),
    `--${alt}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(Buffer.from(html)),
    `--${alt}--`,
  ];
  if (attachment) {
    parts.push(
      `--${mixed}`,
      `Content-Type: application/pdf; name="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      '',
      b64Lines(attachment.content)
    );
  }
  parts.push(`--${mixed}--`, '');
  return parts.join('\r\n');
}

async function sendMail(message, recipients) {
  const c = cfg();
  let socket = await connect(c);
  const s = new Session(socket);
  const helo = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
  try {
    await s.read([220]);
    let ehlo = await s.cmd(`EHLO ${helo}`, [250]);
    if (!c.secure) {
      if (!/STARTTLS/i.test(ehlo.text)) throw new Error('SMTP server does not offer STARTTLS');
      await s.cmd('STARTTLS', [220]);
      s.detach();
      socket = await upgradeToTls(socket, c.host);
      s.attach(socket);
      ehlo = await s.cmd(`EHLO ${helo}`, [250]);
    }
    await s.cmd(`AUTH PLAIN ${Buffer.from(`\0${c.user}\0${c.pass}`).toString('base64')}`, [235]);
    await s.cmd(`MAIL FROM:<${c.user}>`, [250]);
    for (const r of recipients) await s.cmd(`RCPT TO:<${r}>`, [250, 251]);
    await s.cmd('DATA', [354]);
    const body = message.replace(/\r\n\./g, '\r\n..'); // dot-stuffing
    await s.cmd(`${body}\r\n.`, [250]);
    await s.cmd('QUIT', [221]).catch(() => {});
  } finally {
    socket.destroy();
  }
}

/**
 * Email the PDF to the admin(s) (and the employee if EMAIL_TO_EMPLOYEE=true).
 * Never throws: returns a status the UI can show.
 */
async function emailOnboardingPdf({ buffer, filename, data, ref, fileUrl }) {
  const c = cfg();
  if (!isConfigured()) return { configured: false, results: [] };

  const attach = buffer.length <= MAX_ATTACH_BYTES;
  const rows = [
    ['Name', data.fullName],
    ['Mobile (WhatsApp)', `+91 ${data.mobile}`],
    ['Email', data.email],
    ['Joining as', data.designation || 'Not given'],
    ['Date of joining', data.joiningDate || 'Not given'],
    ['Reference', ref],
  ];
  const text = [
    `New joining documents from ${data.fullName}.`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    attach ? 'The complete PDF is attached.' : `The PDF is too large to attach. Open it here: ${fileUrl}`,
    `Link: ${fileUrl}`,
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f4faf6;font-family:Arial,Helvetica,sans-serif;color:#123222">
<div style="max-width:560px;margin:0 auto;padding:24px">
  <div style="background:#ffffff;border:1px solid #d3e9da;border-radius:14px;overflow:hidden">
    <div style="background:#146c34;color:#ffffff;padding:18px 22px;font-size:18px;font-weight:bold">UrCare: new joining documents</div>
    <div style="padding:20px 22px">
      <p style="margin:0 0 14px">${esc(data.fullName)} has submitted the joining documents.</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        ${rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#587064;width:42%">${esc(k)}</td><td style="padding:6px 0;font-weight:bold">${esc(v)}</td></tr>`).join('')}
      </table>
      <p style="margin:16px 0 0">${attach ? 'The complete PDF is attached to this email.' : 'The PDF is too large to attach.'}</p>
      <p style="margin:16px 0 0"><a href="${esc(fileUrl)}" style="display:inline-block;background:#146c34;color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:9px;font-weight:bold">Open PDF</a></p>
    </div>
  </div>
  <p style="font-size:12px;color:#587064;text-align:center">UrCare onboarding. We are always with you.</p>
</div></body></html>`;

  const jobs = [{ role: 'admin', to: c.admins }];
  if (c.toEmployee && data.email) jobs.push({ role: 'employee', to: [data.email] });

  const results = [];
  for (const job of jobs) {
    const subject = job.role === 'admin'
      ? `Joining documents: ${data.fullName} (${ref})`
      : `Your UrCare joining documents (${ref})`;
    const message = buildMessage({
      from: c.user,
      fromName: c.fromName,
      to: job.to,
      subject,
      text,
      html,
      attachment: attach ? { filename, content: buffer } : null,
    });
    try {
      await sendMail(message, job.to);
      results.push({ role: job.role, to: job.to.map(maskEmail).join(', '), ok: true });
    } catch (e) {
      console.error(`[email] send to ${job.role} failed:`, e.message);
      results.push({ role: job.role, to: job.to.map(maskEmail).join(', '), ok: false, error: e.message });
    }
  }
  return { configured: true, results };
}

module.exports = { emailOnboardingPdf, isConfigured };
