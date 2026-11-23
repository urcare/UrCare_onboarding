// Sends the generated PDF on WhatsApp through AiSensy (Campaign API).
// AiSensy downloads the PDF from a public link, so PUBLIC_URL must be an internet address (not localhost).
const { list } = require('./env');

function cfg() {
  const admin = process.env.AISENSY_CAMPAIGN_ADMIN || process.env.AISENSY_CAMPAIGN || '';
  return {
    apiKey: process.env.AISENSY_API_KEY || '',
    url: process.env.AISENSY_API_URL || 'https://backend.aisensy.com/campaign/t1/api/v2',
    campaignAdmin: admin,
    campaignEmployee: process.env.AISENSY_CAMPAIGN_EMPLOYEE || admin,
    // Which values fill the template's {{1}}, {{2}}, ... in order
    params: list(process.env.AISENSY_TEMPLATE_PARAMS || 'name'),
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
  return Boolean(c.apiKey && c.campaignAdmin);
}

const mask = (n) => `+${n.slice(0, 2)} ${'*'.repeat(Math.max(0, n.length - 6))}${n.slice(-4)}`;

function templateParam(key, data, ref) {
  switch (key) {
    case 'name': return data.fullName;
    case 'mobile': return `+91 ${data.mobile}`;
    case 'email': return data.email;
    case 'ref': return ref;
    case 'designation': return data.designation || 'Not given';
    case 'joiningDate': return data.joiningDate || 'Not given';
    default: return key; // fixed text
  }
}

function isPublicUrl(u) {
  try {
    const h = new URL(u).hostname;
    return !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/.test(h);
  } catch (e) { return false; }
}

async function send({ to, campaign, data, ref, fileUrl, filename }) {
  const c = cfg();
  const res = await fetch(c.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      apiKey: c.apiKey,
      campaignName: campaign,
      destination: to,
      userName: data.fullName,
      templateParams: c.params.map((k) => templateParam(k, data, ref)),
      source: 'UrCare onboarding form',
      media: { url: fileUrl, filename },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false || body.success === 'false') {
    throw new Error(body.errorMessage || body.message || body.error || `HTTP ${res.status}`);
  }
  return body;
}

/**
 * Send to every admin number and (optionally) the employee.
 * Never throws: returns a status the UI can show.
 */
async function sendOnboardingPdf({ filename, data, ref, fileUrl }) {
  const c = cfg();
  if (!isConfigured()) return { configured: false, results: [] };

  const recipients = c.admins.map((n) => ({ role: 'admin', to: n }));
  const employee = normalizeNumber(data.mobile);
  if (c.sendToEmployee && employee && !c.admins.includes(employee)) recipients.push({ role: 'employee', to: employee });

  if (!isPublicUrl(fileUrl)) {
    const error = 'AiSensy needs a public link to the PDF. Set PUBLIC_URL in .env to your website address.';
    console.error('[aisensy]', error, `(current: ${fileUrl})`);
    return { configured: true, results: recipients.map((r) => ({ role: r.role, to: mask(r.to), ok: false, error })) };
  }

  const results = [];
  for (const r of recipients) {
    try {
      await send({ to: r.to, campaign: r.role === 'admin' ? c.campaignAdmin : c.campaignEmployee, data, ref, fileUrl, filename });
      results.push({ role: r.role, to: mask(r.to), ok: true });
    } catch (e) {
      console.error(`[aisensy] send to ${mask(r.to)} failed:`, e.message);
      results.push({ role: r.role, to: mask(r.to), ok: false, error: e.message });
    }
  }
  return { configured: true, results };
}

module.exports = { sendOnboardingPdf, isConfigured, normalizeNumber };
