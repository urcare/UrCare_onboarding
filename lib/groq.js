// Reads a marksheet / certificate image with Groq (vision model) and returns one qualification line.
// Needs GROQ_API_KEY in .env. Uses Node 18+ global fetch, no extra dependency.

const API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const isConfigured = () => Boolean(process.env.GROQ_API_KEY);
const model = () => process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

const PROMPT = `You are reading an Indian education document (marksheet, certificate, degree or diploma).
Return ONLY a JSON object with these keys (use "" when not visible, never guess):
{
  "is_education_document": true or false,
  "level": "Class 10" | "Class 12" | "Diploma" | "Graduation" | "Post Graduation" | "Other",
  "course": "exact course name for degrees/diplomas, e.g. B.Sc Nursing, GNM, B.Com. For Class 10/12 use stream if shown, e.g. Science",
  "board_or_university": "board or university name, short form if printed, e.g. CBSE, UP Board, HNB Garhwal University",
  "year": "year of passing, 4 digits",
  "result": "percentage, CGPA or division as printed, e.g. 78.4%, 8.2 CGPA, First Division"
}`;

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120);

function toLine(d) {
  const level = clean(d.level);
  const course = clean(d.course);
  let title;
  if (level === 'Class 10' || level === 'Class 12') title = course ? `${level} (${course})` : level;
  else title = course || level;
  const parts = [title, clean(d.board_or_university), clean(d.year).replace(/[^\d]/g, '').slice(0, 4), clean(d.result)].filter(Boolean);
  return parts.join(', ');
}

async function readMarksheet(imageBuffer, mime = 'image/jpeg') {
  if (!isConfigured()) return { ok: false, message: 'Auto-read is not set up.' };
  const dataUrl = `data:${mime};base64,${imageBuffer.toString('base64')}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model(),
        temperature: 0,
        max_completion_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: dataUrl } }] }],
      }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[groq]', r.status, body && body.error ? body.error.message : body);
      return { ok: false, message: 'Could not read this document right now.' };
    }
    let d;
    try { d = JSON.parse(body.choices[0].message.content); } catch (e) { return { ok: false, message: 'Could not read this document.' }; }
    if (d.is_education_document === false) return { ok: false, notEducation: true, message: 'This does not look like a marksheet or certificate.' };
    const line = toLine(d);
    if (!line) return { ok: false, message: 'Could not find the details on this document.' };
    return { ok: true, line, level: clean(d.level) };
  } catch (e) {
    console.error('[groq] request failed:', e.message);
    return { ok: false, message: 'Could not read this document right now.' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { isConfigured, readMarksheet };
