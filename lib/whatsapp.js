// Sends the generated PDF on WhatsApp using Meta's official WhatsApp Cloud API.
// Docs: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/document-messages
const { list } = require('./env');

function cfg() {
  return {
    token: process.env.WA_TOKEN || '',
    phoneId: process.env.WA_PHONE_NUMBER_ID || '',
    version: process.env.WA_API_VERSION || 'v25.0',
    base: (process.env.WA_API_BASE || 'https://graph.facebook.com').replace(/\/+$/, ''),
    template: process.env.WA_TEMPLATE_NAME || '',
    lang: process.env.WA_TEMPLATE_LANG || 'en',
    templateHasName: (process.env.WA_TEMPLATE_BODY_HAS_NAME || 'true') !== 'false',
    admins: list(process.env.ADMIN_WHATSAPP).map(normalizeNumber).filter(Boolean),
    sendToEmployee: (process.env.SEND_TO_EMPLOYEE || 'true') !== 'false',
  };
}

function normalizeNumber(n) {
  let d = String(n || '').replace(/\D/g, '');
  if (d.length === 10) d = `91${d}`; // assume India when no country code
  return d.length >= 11 ? d : '';
}

function isConfigured() {
  const c = cfg();
  return Boolean(c.token && c.phoneId);
}

const mask = (n) => `+${n.slice(0, 2)} ${'*'.repeat(Math.max(0, n.length - 6))}${n.slice(-4)}`;

async function graph(pathPart, init) {
  const c = cfg();
  const res = await fetch(`${c.base}/${c.version}/${pathPart}`, {
    ...init,
    headers: { Authorization: `Bearer ${c.token}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.error_user_msg || body?.error?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

async function uploadPdf(buffer, filename) {
  const c = cfg();
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp');
  fd.append('type', 'application/pdf');
  fd.append('file', new Blob([buffer], { type: 'application/pdf' }), filename);
  const out = await graph(`${c.phoneId}/media`, { method: 'POST', body: fd });
  return out.id;
}

async function sendDocument(to, mediaId, filename, caption, name) {
  const c = cfg();
  let payload;
  if (c.template) {
    // Business-initiated message: needs an approved template with a DOCUMENT header.
    const components = [{ type: 'header', parameters: [{ type: 'document', document: { id: mediaId, filename } }] }];
    if (c.templateHasName) components.push({ type: 'body', parameters: [{ type: 'text', text: name }] });
    payload = { messaging_product: 'whatsapp', to, type: 'template', template: { name: c.template, language: { code: c.lang }, components } };
  } else {
    // Plain document message: delivered only inside the 24-hour window after that number messaged your business number.
    payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'document', document: { id: mediaId, filename, caption } };
  }
  return graph(`${c.phoneId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/**
 * Upload once, then send to every admin number and (optionally) the employee.
 * Never throws: returns a status the UI can show.
 */
async function sendOnboardingPdf({ buffer, filename, data, ref }) {
  const c = cfg();
  if (!isConfigured()) return { configured: false, results: [] };

  const recipients = c.admins.map((n) => ({ role: 'admin', to: n }));
  const employee = normalizeNumber(data.mobile);
  if (c.sendToEmployee && employee && !c.admins.includes(employee)) recipients.push({ role: 'employee', to: employee });

  let mediaId;
  try {
    mediaId = await uploadPdf(buffer, filename);
  } catch (e) {
    console.error('[whatsapp] upload failed:', e.message);
    return { configured: true, results: recipients.map((r) => ({ role: r.role, to: mask(r.to), ok: false, error: e.message })) };
  }

  const results = [];
  for (const r of recipients) {
    const caption = r.role === 'admin'
      ? `New joining documents: ${data.fullName} (+91 ${data.mobile}). Ref ${ref}.`
      : `Hi ${data.fullName}, here is a copy of the joining documents you submitted to UrCare. Ref ${ref}.`;
    try {
      await sendDocument(r.to, mediaId, filename, caption, data.fullName);
      results.push({ role: r.role, to: mask(r.to), ok: true });
    } catch (e) {
      console.error(`[whatsapp] send to ${mask(r.to)} failed:`, e.message);
      results.push({ role: r.role, to: mask(r.to), ok: false, error: e.message });
    }
  }
  return { configured: true, results };
}

module.exports = { sendOnboardingPdf, isConfigured, normalizeNumber };
