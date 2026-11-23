// UrCare onboarding server: serves the form, builds the combined PDF, sends it on WhatsApp and email.
// Only dependency: pdf-lib. Needs Node.js 18 or newer.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const { loadEnv } = require('./lib/env');
loadEnv();

const { validateSubmission } = require('./lib/validate');
const { buildOnboardingPdf } = require('./lib/pdf');
const { sendOnboardingPdf, isConfigured, normalizeNumber } = require('./lib/whatsapp');
const mailer = require('./lib/mailer');
const groq = require('./lib/groq');
const { createRegistry, FILE_NAME: REGISTRY_FILE } = require('./lib/registry');
const { list } = require('./lib/env');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const STORAGE_DIR = path.resolve(__dirname, process.env.STORAGE_DIR || 'storage');
const MAX_BODY = 80 * 1024 * 1024; // whole submission
const DELETE_AFTER_DAYS = Number(process.env.DELETE_AFTER_DAYS || 0);

const EMPLOYEES_DIR = path.join(STORAGE_DIR, 'employees');
fs.mkdirSync(EMPLOYEES_DIR, { recursive: true });
// Employee data must never reach git/GitHub: keep a .gitignore inside storage as a second guard.
const STORAGE_GITIGNORE = path.join(STORAGE_DIR, '.gitignore');
if (!fs.existsSync(STORAGE_GITIGNORE)) fs.writeFileSync(STORAGE_GITIGNORE, '# Employee data stays on this computer only\n*\n!.gitignore\n!.gitkeep\n');
const registry = createRegistry(STORAGE_DIR);

// Simple per-IP limit for the "already submitted?" check
const hits = new Map();
function tooMany(req, limit = 30, windowMs = 10 * 60 * 1000) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const h = hits.get(ip) || { n: 0, start: now };
  if (now - h.start > windowMs) { h.n = 0; h.start = now; }
  h.n += 1;
  hits.set(ip, h);
  if (hits.size > 5000) hits.clear();
  return h.n > limit;
}

function duplicateMessage(dup) {
  const what = dup.field === 'mobile' ? 'mobile number' : 'email';
  if (!dup.record) return `Documents with this ${what} are being submitted right now. Please wait a minute.`;
  const when = new Date(dup.record.createdAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
  return `Documents with this ${what} were submitted on ${when}. Each person can submit only once. To change something, contact the UrCare admin.`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...headers,
  });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

function makeRef() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000); // IST date
  const ymd = d.toISOString().slice(2, 10).replace(/-/g, '');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `UC-${ymd}-${rand}`;
}

const safeName = (s) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'Employee';

// ---------- handlers ----------
async function handleSubmit(req, res) {
  const type = req.headers['content-type'] || '';
  if (!type.startsWith('multipart/form-data')) return json(res, 415, { ok: false, message: 'Send the form as multipart/form-data.' });
  const len = Number(req.headers['content-length'] || 0);
  if (len > MAX_BODY) return json(res, 413, { ok: false, message: 'Files are too large. Keep the total under 80 MB.' });

  // Count bytes as they stream in, in case content-length is missing or wrong.
  let seen = 0;
  const limited = new Readable({ read() {} });
  req.on('data', (chunk) => {
    seen += chunk.length;
    if (seen > MAX_BODY) { limited.destroy(new Error('too large')); req.destroy(); return; }
    limited.push(chunk);
  });
  req.on('end', () => limited.push(null));
  req.on('error', (e) => limited.destroy(e));

  let form;
  try {
    const request = new Request('http://local/api/submit', {
      method: 'POST',
      headers: { 'content-type': type },
      body: Readable.toWeb(limited),
      duplex: 'half',
    });
    form = await request.formData();
  } catch (e) {
    return json(res, 400, { ok: false, message: 'Could not read the upload. Please try again.' });
  }

  const { data, files, errors } = await validateSubmission(form);
  if (Object.keys(errors).length) return json(res, 422, { ok: false, message: 'Some details need fixing.', errors });

  // One submission per mobile number and per email
  const dup = registry.find({ mobile: data.mobile, email: data.email });
  if (dup) {
    const message = duplicateMessage(dup);
    return json(res, 409, { ok: false, code: 'already_submitted', field: dup.field, message, errors: { [dup.field]: message } });
  }
  const release = registry.reserve({ mobile: data.mobile, email: data.email });
  try {
    return await finishSubmit(req, res, data, files);
  } finally {
    release();
  }
}

async function finishSubmit(req, res, data, files) {
  const ref = makeRef();
  const id = crypto.randomBytes(16).toString('hex');
  const fileName = `UrCare-Joining-${safeName(data.fullName)}-${ref}.pdf`;

  let pdf;
  try {
    pdf = Buffer.from(await buildOnboardingPdf({ data, files, ref }));
  } catch (e) {
    console.error('[pdf] build failed:', e);
    return json(res, 500, { ok: false, message: 'Could not create the PDF. Check that the files open correctly and try again.' });
  }

  // One folder per employee: storage/employees/<date>_<Name>_<ref>/
  const createdAt = new Date().toISOString();
  const folderName = `${ref.split('-')[1] || ''}_${safeName(data.fullName)}_${ref}`;
  const folder = path.join(EMPLOYEES_DIR, folderName);
  saveEmployeeFolder({ folder, fileName, pdf, data, files, ref, createdAt });
  fs.writeFileSync(
    path.join(STORAGE_DIR, `${id}.json`),
    JSON.stringify({ ref, fileName, folder: path.relative(STORAGE_DIR, folder), name: data.fullName, mobile: data.mobile, email: data.email, createdAt }, null, 2)
  );
  registry.add({ ref, id, name: data.fullName, mobile: data.mobile, email: data.email });

  const base = baseUrl(req);
  const fileUrl = `${base}/files/${id}/${encodeURIComponent(fileName)}`;

  // Send on WhatsApp and by email at the same time
  const [whatsapp, email] = await Promise.all([
    sendOnboardingPdf({ buffer: pdf, filename: fileName, data, ref }),
    mailer.emailOnboardingPdf({ buffer: pdf, filename: fileName, data, ref, fileUrl }),
  ]);

  console.log(`[submit] ${ref} ${data.fullName} -> ${pdf.length} bytes, whatsapp: ${JSON.stringify(whatsapp.results.map((r) => r.ok))}, email: ${JSON.stringify(email.results.map((r) => r.ok))}`);
  return json(res, 200, { ok: true, ref, fileName, fileUrl, downloadUrl: `${fileUrl}?download=1`, sizeBytes: pdf.length, whatsapp, email });
}

// Marksheet / certificate image -> one qualification line (Groq vision)
const MAX_AI_IMAGE = 4 * 1024 * 1024; // Groq limit for base64 images
async function handleReadMarksheet(req, res) {
  if (!groq.isConfigured()) return json(res, 503, { ok: false, message: 'Auto-read is not set up.' });
  if (tooMany(req, 40)) return json(res, 429, { ok: false, message: 'Too many documents read. Type the details instead.' });
  const type = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) return json(res, 415, { ok: false, message: 'Send a JPG or PNG image.' });
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_AI_IMAGE) return json(res, 413, { ok: false, message: 'Image is too large to read.' });
      chunks.push(chunk);
    }
  } catch (e) {
    return json(res, 400, { ok: false, message: 'Could not read the upload.' });
  }
  const result = await groq.readMarksheet(Buffer.concat(chunks), type);
  return json(res, result.ok ? 200 : 422, result);
}

// Saves everything for one employee in its own folder:
//   details.json   all form details
//   details.txt    the same, easy to read
//   <name>.pdf     the combined PDF that was sent
//   documents/     every original upload, named by document type
const DOC_LABELS = {
  photo: 'Passport-Photo', aadhaarFiles: 'Aadhaar', panFile: 'PAN', resumeFile: 'Resume',
  educationFiles: 'Education', experienceFiles: 'Experience-Letter', passbookFile: 'Bank-Passbook',
};
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };

function saveEmployeeFolder({ folder, fileName, pdf, data, files, ref, createdAt }) {
  const docsDir = path.join(folder, 'documents');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(folder, fileName), pdf);

  const documents = [];
  for (const [field, list] of Object.entries(files || {})) {
    (list || []).forEach((f, i) => {
      const label = DOC_LABELS[field] || field;
      const ext = EXT[f.type] || path.extname(f.name || '') || '';
      const name = `${label}${list.length > 1 ? `-${i + 1}` : ''}${ext}`;
      fs.writeFileSync(path.join(docsDir, name), f.buffer);
      documents.push({ type: label, file: `documents/${name}`, originalName: f.name, bytes: f.buffer.length });
    });
  }

  const record = { ref, submittedAt: createdAt, details: data, pdf: fileName, documents };
  fs.writeFileSync(path.join(folder, 'details.json'), JSON.stringify(record, null, 2));
  const lines = [`UrCare joining details  |  ${ref}  |  ${new Date(createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`, ''];
  for (const [k, v] of Object.entries(data)) if (v !== '' && v != null) lines.push(`${k}: ${v}`);
  lines.push('', 'Documents:', ...documents.map((d) => `  ${d.file}  (original: ${d.originalName})`));
  fs.writeFileSync(path.join(folder, 'details.txt'), lines.join('\n'));
}

function pdfPathFor(id) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(STORAGE_DIR, `${id}.json`), 'utf8'));
    if (meta.folder) {
      const p = path.resolve(STORAGE_DIR, meta.folder, meta.fileName);
      if (p.startsWith(EMPLOYEES_DIR + path.sep)) return { pdfPath: p, fileName: meta.fileName };
    }
    return { pdfPath: path.join(STORAGE_DIR, `${id}.pdf`), fileName: meta.fileName }; // older submissions
  } catch (e) {
    return { pdfPath: path.join(STORAGE_DIR, `${id}.pdf`), fileName: '' };
  }
}

function handleFile(req, res, id, url) {
  if (!/^[a-f0-9]{32}$/.test(id)) return send(res, 404, 'Not found');
  const found = pdfPathFor(id);
  const pdfPath = found.pdfPath;
  if (!fs.existsSync(pdfPath)) return send(res, 404, 'This file is no longer available.');
  const fileName = found.fileName || 'UrCare-Joining.pdf';
  const disp = url.searchParams.has('download') ? 'attachment' : 'inline';
  const stat = fs.statSync(pdfPath);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': stat.size,
    'Content-Disposition': `${disp}; filename="${fileName}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  fs.createReadStream(pdfPath).pipe(res);
}

function handleStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const ext = path.extname(filePath).toLowerCase();
    const cache = ['.html', '.css', '.js'].includes(ext) ? 'no-cache' : 'public, max-age=86400';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;

    if (p === '/api/config' && req.method === 'GET') {
      const admin = list(process.env.ADMIN_WHATSAPP).map(normalizeNumber).filter(Boolean)[0] || '';
      return json(res, 200, {
        whatsappAuto: isConfigured(),
        adminWhatsapp: admin,
        sendsToEmployee: isConfigured() && (process.env.SEND_TO_EMPLOYEE || 'true') !== 'false',
        emailAuto: mailer.isConfigured(),
        aiRead: groq.isConfigured(),
      });
    }
    if (p === '/api/check' && req.method === 'GET') {
      if (tooMany(req)) return json(res, 429, { ok: false, message: 'Too many checks. Try again in a few minutes.' });
      const dup = registry.find({ mobile: url.searchParams.get('mobile'), email: url.searchParams.get('email') });
      return json(res, 200, dup ? { exists: true, field: dup.field, message: duplicateMessage(dup) } : { exists: false });
    }
    if (p === '/api/submit' && req.method === 'POST') return await handleSubmit(req, res);
    if (p === '/api/read-marksheet' && req.method === 'POST') return await handleReadMarksheet(req, res);

    const m = p.match(/^\/files\/([a-f0-9]{32})(?:\/[^/]*)?$/);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) return handleFile(req, res, m[1], url);

    if (req.method === 'GET' || req.method === 'HEAD') return handleStatic(req, res, p);
    return send(res, 405, 'Method not allowed');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { ok: false, message: 'Something went wrong on the server. Please try again.' });
  }
});

// Optional clean-up of old PDFs
function cleanup() {
  if (!DELETE_AFTER_DAYS) return;
  const cutoff = Date.now() - DELETE_AFTER_DAYS * 86400000;
  for (const f of fs.readdirSync(STORAGE_DIR)) {
    if (!/\.(pdf|json)$/.test(f) || f === REGISTRY_FILE) continue; // never delete the submissions list
    const fp = path.join(STORAGE_DIR, f);
    if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
  }
}
cleanup();
setInterval(cleanup, 12 * 3600 * 1000).unref();

server.listen(PORT, () => {
  console.log(`UrCare onboarding running at http://localhost:${PORT}`);
  console.log(isConfigured() ? 'WhatsApp auto-send: ON' : 'WhatsApp auto-send: OFF (add WA_TOKEN and WA_PHONE_NUMBER_ID in .env)');
  console.log(groq.isConfigured() ? 'Marksheet auto-read (Groq): ON' : 'Marksheet auto-read (Groq): OFF (add GROQ_API_KEY in .env)');
  console.log(mailer.isConfigured() ? 'Email to admin: ON' : 'Email to admin: OFF (add ADMIN_EMAIL, SMTP_USER and SMTP_PASS in .env)');
});
