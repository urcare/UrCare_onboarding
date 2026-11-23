// Remembers who has already submitted, so the same mobile number or email can't submit twice.
// Stored in storage/submissions.json. Use scripts/allow-resubmit.js to let someone submit again.
const fs = require('fs');
const path = require('path');

const FILE_NAME = 'submissions.json';

const normMobile = (m) => {
  let d = String(m || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  return d;
};
const normEmail = (e) => String(e || '').trim().toLowerCase();

function createRegistry(storageDir) {
  const file = path.join(storageDir, FILE_NAME);
  const pending = new Set(); // keys of submissions being processed right now

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch (e) {
      return [];
    }
  }

  function save(list) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, file);
  }

  /** Returns { field: 'mobile' | 'email', record } for the first match, or null. */
  function find({ mobile, email }) {
    const m = normMobile(mobile);
    const e = normEmail(email);
    for (const r of load()) {
      if (m && r.mobile === m) return { field: 'mobile', record: r };
      if (e && r.email === e) return { field: 'email', record: r };
    }
    if (m && pending.has(`m:${m}`)) return { field: 'mobile', record: null };
    if (e && pending.has(`e:${e}`)) return { field: 'email', record: null };
    return null;
  }

  /** Reserve the keys while the PDF is being built. Returns a release function. */
  function reserve({ mobile, email }) {
    const keys = [`m:${normMobile(mobile)}`, `e:${normEmail(email)}`];
    keys.forEach((k) => pending.add(k));
    return () => keys.forEach((k) => pending.delete(k));
  }

  function add({ ref, id, name, mobile, email }) {
    const list = load();
    list.push({ ref, id, name, mobile: normMobile(mobile), email: normEmail(email), createdAt: new Date().toISOString() });
    save(list);
  }

  /** Remove every record that matches a mobile number or email. Returns how many were removed. */
  function remove(value) {
    const m = normMobile(value);
    const e = normEmail(value);
    const list = load();
    const keep = list.filter((r) => !((m.length === 10 && r.mobile === m) || (e.includes('@') && r.email === e)));
    if (keep.length !== list.length) save(keep);
    return list.length - keep.length;
  }

  return { find, reserve, add, remove, file };
}

module.exports = { createRegistry, FILE_NAME };
