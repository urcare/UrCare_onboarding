/* UrCare onboarding: form steps, uploads, live checklist, submit, share */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const form = $('#form');
  const steps = $$('.step');
  const TOTAL = steps.length;
  const MAX_BYTES = 10 * 1024 * 1024;

  let current = 1;
  let dirty = false;
  let submitted = false;
  let busy = false;
  let config = { whatsappAuto: false, adminWhatsapp: '', sendsToEmployee: false, emailAuto: false };
  const files = {}; // field -> [{ id, name, file, url, ready }]

  fetch('/api/config')
    .then((r) => r.json())
    .then((c) => {
      config = { ...config, ...c };
      if (config.aiRead) $('#eduDropHint').textContent = 'Upload 10th, 12th, graduation marksheets. We fill in your qualifications from them. Up to 8 files.';
      if (!config.sendsToEmployee) $('#mobile').closest('.field').querySelector('.hint').textContent = 'The UrCare team will use this number to reach you.';
    })
    .catch(() => {});

  // ---------- helpers ----------
  const val = (id) => (form.elements[id] ? String(form.elements[id].value || '').trim() : '');
  const radio = (name) => (form.querySelector(`input[name="${name}"]:checked`) || {}).value || '';
  const digits = (s) => String(s).replace(/\D/g, '');
  const count = (field) => (files[field] || []).filter((f) => f.ready).length;
  const uid = () => Math.random().toString(36).slice(2, 10);
  const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const fmtAadhaar = (d) => d.replace(/(\d{4})(?=\d)/g, '$1 ');

  // Verhoeff checksum (all real Aadhaar numbers pass it)
  const VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
  const VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
  const verhoeff = (num) => { let c = 0; num.split('').reverse().forEach((d, i) => { c = VD[c][VP[i % 8][+d]]; }); return c === 0; };

  // ---------- rules ----------
  const rules = {
    fullName: () => {
      const v = val('fullName');
      if (!v) return 'Enter your full name.';
      return /^[A-Za-z][A-Za-z .'-]{1,79}$/.test(v) ? '' : 'Use English letters only, as on your Aadhaar.';
    },
    mobile: () => (/^[6-9]\d{9}$/.test(digits(val('mobile'))) ? '' : 'Enter a 10-digit mobile number.'),
    email: () => {
      if (!val('email')) return 'Enter your email.';
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val('email')) ? '' : 'Enter a valid email, like name@gmail.com.';
    },
    aadhaarNumber: () => {
      const d = digits(val('aadhaarNumber'));
      if (d.length !== 12) return 'Aadhaar number has 12 digits.';
      return /^[2-9]/.test(d) && verhoeff(d) ? '' : 'This Aadhaar number is not valid. Check the digits.';
    },
    aadhaarFiles: () => (count('aadhaarFiles') ? '' : 'Upload your Aadhaar card.'),
    panNumber: () => (/^[A-Z]{5}\d{4}[A-Z]$/.test(val('panNumber').toUpperCase()) ? '' : 'PAN has 10 characters, like ABCDE1234F.'),
    panFile: () => (count('panFile') ? '' : 'Upload your PAN card.'),
    photo: () => (count('photo') ? '' : 'Upload a passport size photo.'),
    hasResume: () => (radio('hasResume') ? '' : 'Choose yes or no.'),
    resumeFile: () => (radio('hasResume') !== 'yes' || count('resumeFile') ? '' : 'Upload your resume, or choose No.'),
    educationDetails: () => (val('educationDetails').length >= 3 ? '' : 'Write your qualifications.'),
    educationFiles: () => (count('educationFiles') ? '' : 'Upload at least one certificate.'),
    workStatus: () => (radio('workStatus') ? '' : 'Choose Experience or Fresher.'),
    experienceYears: () => {
      if (radio('workStatus') !== 'experienced') return '';
      const n = Number(val('experienceYears'));
      return n > 0 && n <= 50 ? '' : 'Enter your total experience in years.';
    },
    lastCompany: () => (radio('workStatus') !== 'experienced' || val('lastCompany').length >= 2 ? '' : 'Enter your last company name.'),
    bankAccount: () => (/^\d{9,18}$/.test(val('bankAccount')) ? '' : 'Account number has 9 to 18 digits.'),
    bankAccountConfirm: () => {
      if (!val('bankAccountConfirm')) return 'Re-enter your account number.';
      return val('bankAccountConfirm') === val('bankAccount') ? '' : 'The two account numbers do not match.';
    },
    ifsc: () => (/^[A-Z]{4}0[A-Z0-9]{6}$/.test(val('ifsc').toUpperCase()) ? '' : 'IFSC has 11 characters, like SBIN0001234.'),
    passbookFile: () => (count('passbookFile') ? '' : 'Upload your passbook front page or a cancelled cheque.'),
    address: () => (val('address').length >= 10 ? '' : 'Enter your full address with PIN code.'),
    declaration: () => (form.elements.declaration.checked ? '' : 'Tick the box to confirm.'),
  };

  const stepFields = {
    1: ['fullName', 'mobile', 'email'],
    2: ['aadhaarNumber', 'aadhaarFiles', 'panNumber', 'panFile', 'photo'],
    3: ['hasResume', 'resumeFile', 'educationDetails', 'educationFiles', 'workStatus', 'experienceYears', 'lastCompany'],
    4: ['bankAccount', 'bankAccountConfirm', 'ifsc', 'passbookFile', 'address'],
    5: ['declaration'],
  };
  const checklistFields = {
    1: ['aadhaarNumber', 'aadhaarFiles'],
    2: ['panNumber', 'panFile'],
    3: ['photo'],
    4: ['hasResume', 'resumeFile'],
    5: ['educationDetails', 'educationFiles'],
    6: ['workStatus', 'experienceYears', 'lastCompany'],
    7: ['bankAccount', 'bankAccountConfirm', 'ifsc', 'passbookFile'],
    8: ['address'],
  };
  const stepOf = (field) => Number(Object.keys(stepFields).find((s) => stepFields[s].includes(field)) || 1);

  // ---------- errors ----------
  function containerOf(field) {
    const upload = $(`.upload[data-field="${field}"]`);
    if (upload) return upload;
    if (field === 'hasResume' || field === 'workStatus') return form.querySelector(`input[name="${field}"]`).closest('.choice');
    if (field === 'declaration') return $('.declare');
    const el = $(`#${field}`);
    return el ? el.closest('.field') : null;
  }
  function focusTarget(field) {
    const upload = $(`.upload[data-field="${field}"]`);
    if (upload) return upload.querySelector('input[type=file]');
    if (field === 'hasResume' || field === 'workStatus') return form.querySelector(`input[name="${field}"]`);
    return $(`#${field}`);
  }
  function setError(field, msg) {
    const box = $(`#${field}-err`);
    if (box) box.textContent = msg || '';
    const c = containerOf(field);
    if (c) c.classList.toggle('is-invalid', Boolean(msg));
    const input = focusTarget(field);
    if (input) {
      if (msg) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', `${field}-err`); }
      else input.removeAttribute('aria-invalid');
    }
  }
  const check = (field) => { const msg = rules[field] ? rules[field]() : ''; setError(field, msg); return !msg; };

  function validateStep(n) {
    let first = null;
    for (const f of stepFields[n]) {
      const c = containerOf(f);
      if (c && c.closest('[hidden]')) { setError(f, ''); continue; }
      if (!check(f) && !first) first = f;
    }
    if (first) {
      const c = containerOf(first);
      const t = focusTarget(first);
      if (t) t.focus({ preventScroll: true });
      if (c) {
        c.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
        c.classList.remove('shake'); void c.offsetWidth; c.classList.add('shake');
      }
      return false;
    }
    return true;
  }

  // ---------- checklist ----------
  function updateChecklist() {
    let done = 0;
    for (const [item, fields] of Object.entries(checklistFields)) {
      const ok = fields.every((f) => !rules[f]());
      $(`.cl-list li[data-item="${item}"]`).classList.toggle('is-done', ok);
      if (ok) done += 1;
    }
    $('#doneCount').textContent = done;
  }

  // ---------- steps ----------
  function goTo(n, dir = 1) {
    steps.forEach((s) => { s.hidden = Number(s.dataset.step) !== n; s.classList.remove('enter-fwd', 'enter-back'); });
    const el = steps[n - 1];
    void el.offsetWidth;
    el.classList.add(dir >= 0 ? 'enter-fwd' : 'enter-back');
    current = n;
    $('#stepNo').textContent = n;
    $('#stepBar').style.width = `${(n / TOTAL) * 100}%`;
    $('#backBtn').hidden = n === 1;
    $('#nextBtn').textContent = n === TOTAL ? 'Submit documents' : 'Continue';
    $('#intro').hidden = n !== 1;
    $('#formError').hidden = true;
    $$('.cl-list li').forEach((li) => li.classList.toggle('is-current', Number(li.dataset.step) === n));
    if (n === TOTAL) renderReview();
    const panel = $('#panel');
    if (panel.getBoundingClientRect().top < 0) panel.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    panel.focus({ preventScroll: true });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    // Tell people who already submitted straight away, before they fill anything else
    if (current === 1 && !rules.mobile() && !rules.email() && (await alreadySubmitted())) return;
    if (!validateStep(current)) return;
    if (current < TOTAL) goTo(current + 1, 1);
    else submitAll();
  });

  // ---------- one submission per mobile + email ----------
  async function alreadySubmitted() {
    const btn = $('#nextBtn');
    busy = true;
    btn.disabled = true;
    btn.textContent = 'Checking';
    try {
      const q = `mobile=${encodeURIComponent(digits(val('mobile')))}&email=${encodeURIComponent(val('email').toLowerCase())}`;
      const r = await fetch(`/api/check?${q}`, { cache: 'no-store' });
      if (!r.ok) return false; // the server checks again on submit
      const d = await r.json();
      if (d.exists) { showDuplicate(d.field, d.message); return true; }
      return false;
    } catch (err) {
      return false;
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = current === TOTAL ? 'Submit documents' : 'Continue';
    }
  }

  function showDuplicate(field, message) {
    const f = field === 'email' ? 'email' : 'mobile';
    $('#dupText').textContent = message;
    const box = $('#dupNotice');
    box.hidden = false;
    setError(f, f === 'mobile' ? 'This mobile number has already been used to submit.' : 'This email has already been used to submit.');
    box.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    box.focus({ preventScroll: true });
  }
  $('#backBtn').addEventListener('click', () => goTo(Math.max(1, current - 1), -1));

  // ---------- input formatting + live checks ----------
  const formatters = {
    mobile: (v) => { let d = digits(v); if (d.length > 10 && d.startsWith('91')) d = d.slice(2); if (d.length > 10 && d.startsWith('0')) d = d.slice(1); return d.slice(0, 10); },
    aadhaarNumber: (v) => fmtAadhaar(digits(v).slice(0, 12)),
    panNumber: (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10),
    ifsc: (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11),
    bankAccount: (v) => digits(v).slice(0, 18),
    bankAccountConfirm: (v) => digits(v).slice(0, 18),
  };

  form.addEventListener('input', (e) => {
    const t = e.target;
    if (!t.id && t.type !== 'radio') return;
    dirty = true;
    if (formatters[t.id]) {
      const next = formatters[t.id](t.value);
      if (next !== t.value) t.value = next;
    }
    if (t.id === 'mobile' || t.id === 'email') $('#dupNotice').hidden = true;
    const c = t.id && containerOf(t.id);
    if (c && c.classList.contains('is-invalid')) check(t.id);
    if (t.id === 'bankAccount' && $('#bankAccountConfirm').value) check('bankAccountConfirm');
    updateChecklist();
  });
  form.addEventListener('focusout', (e) => {
    const t = e.target;
    if (t.id && rules[t.id] && t.value && t.type !== 'file' && t.type !== 'checkbox') check(t.id);
  });
  form.addEventListener('change', (e) => {
    const t = e.target;
    if (t.type === 'radio') {
      setError(t.name, '');
      syncReveals();
    }
    if (t.id === 'declaration') check('declaration');
    updateChecklist();
  });

  function syncReveals() {
    $$('.reveal').forEach((r) => {
      const [name, v] = r.dataset.showWhen.split('=');
      const show = radio(name) === v;
      if (r.hidden === !show) return;
      r.hidden = !show;
      if (!show) $$('.err', r).forEach((er) => setError(er.id.replace(/-err$/, ''), ''));
    });
  }

  // ---------- uploads ----------
  const isImageFile = (f) => (f.type || '').startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(f.name);
  const isPdfFile = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

  function bytesInclude(bytes, ascii) {
    const pat = [...ascii].map((c) => c.charCodeAt(0));
    outer: for (let i = 0; i <= bytes.length - pat.length; i++) {
      for (let j = 0; j < pat.length; j++) if (bytes[i + j] !== pat[j]) continue outer;
      return true;
    }
    return false;
  }

  async function checkFile(f, imagesOnly, maxBytes) {
    const img = isImageFile(f);
    const pdf = isPdfFile(f);
    if (imagesOnly && !img) return 'Upload a photo (JPG or PNG).';
    if (maxBytes && f.size > maxBytes) return `${f.name} is larger than ${Math.round(maxBytes / 1048576)} MB. Choose a smaller photo.`;
    if (!img && !pdf) return `${f.name} is not a photo or PDF.`;
    if (pdf) {
      if (f.size > MAX_BYTES) return `${f.name} is larger than 10 MB.`;
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (!bytesInclude(bytes.subarray(0, 1024), '%PDF-')) return `${f.name} is not a valid PDF.`;
      if (bytesInclude(bytes, '/Encrypt')) return `${f.name} is password-protected (e-Aadhaar PDFs usually are). Upload a photo or screenshot instead.`;
    }
    if (img && f.size > 30 * 1024 * 1024) return `${f.name} is too large. Use a smaller photo.`;
    return '';
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      im.src = url;
    });
  }

  // Re-encode photos as JPEG (max 2000px): smaller uploads, correct rotation, HEIC/WebP handled where the browser can read them.
  async function compressImage(file) {
    let src;
    try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { src = await loadImage(file); }
    const w0 = src.width || src.naturalWidth;
    const h0 = src.height || src.naturalHeight;
    const scale = Math.min(1, 2000 / Math.max(w0, h0));
    const w = Math.round(w0 * scale);
    const h = Math.round(h0 * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    if (src.close) src.close();
    const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.85));
    const base = file.name.replace(/\.[^.]+$/, '') || 'photo';
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
  }

  const X_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg>';

  function renderFile(box, entry) {
    let li = box.querySelector(`[data-id="${entry.id}"]`);
    if (!li) {
      li = document.createElement('li');
      li.className = 'file';
      li.dataset.id = entry.id;
      li.innerHTML = `<span class="thumb thumb-pdf">PDF</span><div class="file-meta"><span class="file-name"></span><span class="file-size"></span></div><button type="button" class="file-remove">${X_ICON}</button>`;
      li.querySelector('.file-name').textContent = entry.name;
      li.querySelector('.file-remove').setAttribute('aria-label', `Remove ${entry.name}`);
      li.querySelector('.file-remove').addEventListener('click', () => removeFile(box, entry.id));
      box.querySelector('.files').appendChild(li);
    }
    li.classList.toggle('is-busy', !entry.ready);
    li.querySelector('.file-size').textContent = fmtSize(entry.size);
    if (entry.url && !li.querySelector('img.thumb')) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.alt = '';
      img.src = entry.url;
      li.querySelector('.thumb').replaceWith(img);
    }
    if (entry.name !== li.querySelector('.file-name').textContent) li.querySelector('.file-name').textContent = entry.name;
  }

  function refreshUpload(box) {
    const field = box.dataset.field;
    box.classList.toggle('is-full', files[field].length >= Number(box.dataset.max));
  }

  function removeFile(box, id) {
    const field = box.dataset.field;
    const idx = files[field].findIndex((f) => f.id === id);
    if (idx === -1) return;
    const [entry] = files[field].splice(idx, 1);
    if (aiLines[id]) { removeQualLine(aiLines[id]); delete aiLines[id]; }
    aiFailed = aiFailed.filter((n) => n !== entry.name);
    if (field === 'educationFiles') updateAiNote();
    if (entry.url) setTimeout(() => URL.revokeObjectURL(entry.url), 1000);
    const li = box.querySelector(`[data-id="${id}"]`);
    const finish = () => { li && li.remove(); refreshUpload(box); updateChecklist(); box.querySelector('input[type=file]').focus({ preventScroll: true }); };
    if (li && !reduceMotion) { li.classList.add('is-leaving'); setTimeout(finish, 220); } else finish();
  }

  async function addFiles(box, list) {
    const field = box.dataset.field;
    const max = Number(box.dataset.max);
    const imagesOnly = box.dataset.imagesOnly === 'true';
    const maxBytes = Number(box.dataset.maxMb || 0) * 1048576;
    setError(field, '');
    dirty = true;
    const room = max - files[field].length;
    if (!list.length) return;
    if (room <= 0) { setError(field, `You can add up to ${max} file${max > 1 ? 's' : ''} here. Remove one first.`); return; }
    if (list.length > room) setError(field, `Only ${max} file${max > 1 ? 's' : ''} allowed here. Extra files were left out.`);

    for (const f of list.slice(0, room)) {
      const problem = await checkFile(f, imagesOnly, maxBytes);
      if (problem) { setError(field, problem); continue; }
      const entry = { id: uid(), name: f.name, size: f.size, file: null, url: null, ready: false };
      files[field].push(entry);
      renderFile(box, entry);
      refreshUpload(box);
      try {
        entry.file = isImageFile(f) ? await compressImage(f) : f;
        entry.name = entry.file.name;
        entry.size = entry.file.size;
        if (isImageFile(f)) entry.url = URL.createObjectURL(entry.file);
        entry.ready = true;
        renderFile(box, entry);
        if (field === 'educationFiles') autoRead(box, entry);
      } catch (e) {
        files[field] = files[field].filter((x) => x.id !== entry.id);
        const li = box.querySelector(`[data-id="${entry.id}"]`);
        if (li) li.remove();
        setError(field, `${f.name} could not be opened. Use a JPG, PNG or PDF.`);
      }
    }
    refreshUpload(box);
    updateChecklist();
  }

  // ---------- marksheet auto-read (Groq, via our server) ----------
  const aiLines = {}; // file id -> line we added to "Your qualifications"
  let aiPending = 0;
  let aiFailed = [];
  let aiFilled = 0;

  function updateAiNote() {
    const note = $('#eduAi');
    note.classList.remove('is-warn', 'is-busy');
    if (aiPending) {
      note.textContent = `Reading your marksheet${aiPending > 1 ? 's' : ''}… details will appear above.`;
      note.classList.add('is-busy');
    } else if (aiFailed.length) {
      note.textContent = `Could not read ${aiFailed.join(', ')}. Please type its details above.`;
      note.classList.add('is-warn');
    } else if (aiFilled && Object.keys(aiLines).length) {
      note.textContent = 'Filled in from your documents. Please check and correct if anything is wrong.';
    } else { note.hidden = true; return; }
    note.hidden = false;
  }

  function setQualText(text) {
    const ta = $('#educationDetails');
    ta.value = text.slice(0, ta.maxLength > 0 ? ta.maxLength : 600);
    dirty = true;
    if (containerOf('educationDetails').classList.contains('is-invalid')) check('educationDetails');
    updateChecklist();
  }
  function addQualLine(line) {
    const cur = $('#educationDetails').value;
    if (cur.toLowerCase().includes(line.toLowerCase())) return;
    setQualText(cur.trim() ? `${cur.replace(/\s+$/, '')}\n${line}` : line);
  }
  function removeQualLine(line) {
    const lines = $('#educationDetails').value.split('\n');
    const i = lines.findIndex((l) => l.trim() === line);
    if (i === -1) return;
    lines.splice(i, 1);
    setQualText(lines.join('\n'));
  }

  // PDF marksheets: render page 1 to a JPEG in the browser (pdf.js, loaded only when needed)
  let pdfjsReady;
  function loadPdfJs() {
    if (!pdfjsReady) {
      const base = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
      pdfjsReady = new Promise((resolve, reject) => {
        const sc = document.createElement('script');
        sc.src = `${base}pdf.min.js`;
        sc.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.js`; resolve(window.pdfjsLib); };
        sc.onerror = () => { pdfjsReady = null; reject(new Error('pdfjs')); };
        document.head.appendChild(sc);
      });
    }
    return pdfjsReady;
  }
  async function pdfFirstPage(file) {
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const page = await doc.getPage(1);
    const v1 = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(3, 1800 / Math.max(v1.width, v1.height)) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    doc.destroy();
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.85));
  }

  async function autoRead(box, entry) {
    if (!config.aiRead || !entry.file) return;
    const li = box.querySelector(`[data-id="${entry.id}"]`);
    aiPending += 1;
    if (li) li.classList.add('is-reading');
    updateAiNote();
    let ok = false;
    try {
      const img = isPdfFile(entry.file) ? await pdfFirstPage(entry.file) : entry.file;
      const r = await fetch('/api/read-marksheet', { method: 'POST', headers: { 'Content-Type': img.type || 'image/jpeg' }, body: img });
      const d = await r.json().catch(() => ({}));
      const stillThere = files.educationFiles.some((f) => f.id === entry.id);
      if (d.ok && d.line && stillThere) {
        aiLines[entry.id] = d.line;
        addQualLine(d.line);
        aiFilled += 1;
        ok = true;
      } else if (d.notEducation || !stillThere) ok = true; // not a marksheet, or removed meanwhile: skip quietly
    } catch (e) { /* shown as "could not read" below */ }
    aiPending -= 1;
    if (!ok) aiFailed.push(entry.name);
    if (li) li.classList.remove('is-reading');
    updateAiNote();
  }

  $$('.upload').forEach((box) => {
    files[box.dataset.field] = [];
    const input = box.querySelector('input[type=file]');
    const drop = box.querySelector('.drop');
    input.addEventListener('change', () => { const picked = [...input.files]; input.value = ''; addFiles(box, picked); });
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); box.classList.add('is-drag'); }));
    ['dragleave', 'dragend'].forEach((ev) => drop.addEventListener(ev, (e) => { if (!drop.contains(e.relatedTarget)) box.classList.remove('is-drag'); }));
    drop.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('is-drag'); addFiles(box, [...(e.dataTransfer?.files || [])]); });
  });
  // Don't let a missed drop open the file in the browser
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // ---------- review ----------
  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  const fileText = (field) => {
    const list = (files[field] || []).filter((f) => f.ready);
    if (!list.length) return 'Not added';
    return list.length === 1 ? list[0].name : `${list.length} files`;
  };

  function renderReview() {
    const wrap = $('#review');
    wrap.textContent = '';
    const exp = radio('workStatus') === 'experienced';
    const sections = [
      [1, 'About you', [
        ['Full name', val('fullName')],
        ['WhatsApp number', `+91 ${val('mobile')}`],
        ['Email', val('email') || 'Not given'],
        ['Joining as', val('designation') || 'Not given'],
        ['Date of joining', val('joiningDate') ? new Date(`${val('joiningDate')}T00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Not given'],
      ]],
      [2, 'ID proofs and photo', [
        ['Aadhaar number', fmtAadhaar(digits(val('aadhaarNumber')))],
        ['Aadhaar card', fileText('aadhaarFiles')],
        ['PAN number', val('panNumber')],
        ['PAN card', fileText('panFile')],
        ['Passport photo', { photo: true }],
      ]],
      [3, 'Education and work', [
        ['Resume / CV', radio('hasResume') === 'yes' ? `Yes, ${fileText('resumeFile')}` : 'No'],
        ['Qualifications', val('educationDetails')],
        ['Certificates', fileText('educationFiles')],
        ['Experience or fresher', exp ? `Experience: ${val('experienceYears')} year(s), last at ${val('lastCompany')}` : 'Fresher'],
        ...(exp ? [['Experience letter', count('experienceFiles') ? fileText('experienceFiles') : 'Not added']] : []),
      ]],
      [4, 'Bank and address', [
        ['Account number', val('bankAccount')],
        ['IFSC code', val('ifsc')],
        ['Passbook', fileText('passbookFile')],
        ['Address', val('address')],
      ]],
    ];
    for (const [step, title, rows] of sections) {
      const box = el('section', 'rv');
      const head = el('div', 'rv-head');
      head.appendChild(el('h3', null, title));
      const edit = el('button', 'rv-edit', 'Edit');
      edit.type = 'button';
      edit.setAttribute('aria-label', `Edit ${title.toLowerCase()}`);
      edit.addEventListener('click', () => goTo(step, -1));
      head.appendChild(edit);
      box.appendChild(head);
      const dl = el('dl');
      rows.forEach(([k, v]) => {
        dl.appendChild(el('dt', null, k));
        if (v && v.photo) {
          const dd = el('dd');
          const ph = (files.photo || []).find((f) => f.ready);
          if (ph && ph.url) { const img = el('img', 'rv-photo'); img.src = ph.url; img.alt = 'Your passport photo'; dd.appendChild(img); } else dd.textContent = 'Not added';
          dl.appendChild(dd);
        } else dl.appendChild(el('dd', null, v));
      });
      box.appendChild(dl);
      wrap.appendChild(box);
    }
  }

  // ---------- submit ----------
  const overlay = $('#overlay');
  const setOverlay = (title, pct, sub) => {
    $('#overlayTitle').textContent = title;
    if (pct != null) $('#progressBar').style.width = `${pct}%`;
    if (sub) $('#overlaySub').textContent = sub;
  };

  function submitAll() {
    for (let s = 1; s < TOTAL; s++) {
      if (!validateStep(s)) { goTo(s, -1); validateStep(s); return; }
    }
    const pending = Object.values(files).flat().some((f) => !f.ready);
    if (pending) { showFormError('Some files are still being prepared. Wait a second and submit again.'); return; }

    const fd = new FormData();
    ['fullName', 'email', 'designation', 'joiningDate', 'educationDetails', 'experienceYears', 'lastCompany', 'address'].forEach((k) => fd.append(k, val(k)));
    fd.append('mobile', digits(val('mobile')));
    fd.append('aadhaarNumber', digits(val('aadhaarNumber')));
    fd.append('panNumber', val('panNumber').toUpperCase());
    fd.append('bankAccount', val('bankAccount'));
    fd.append('ifsc', val('ifsc').toUpperCase());
    fd.append('hasResume', radio('hasResume'));
    fd.append('workStatus', radio('workStatus'));
    fd.append('declaration', 'yes');
    for (const [field, list] of Object.entries(files)) {
      if (field === 'resumeFile' && radio('hasResume') !== 'yes') continue;
      if (field === 'experienceFiles' && radio('workStatus') !== 'experienced') continue;
      list.filter((f) => f.ready).forEach((f) => fd.append(field, f.file, f.file.name));
    }

    const btn = $('#nextBtn');
    btn.disabled = true;
    overlay.hidden = false;
    setOverlay('Uploading your documents', 2, 'Please keep this page open.');

    let stageTimer;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/submit');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) setOverlay('Uploading your documents', Math.max(2, (e.loaded / e.total) * 70)); };
    xhr.upload.onload = () => {
      setOverlay('Making your PDF', 80, 'Putting every document into one file.');
      stageTimer = setTimeout(() => setOverlay('Sending on WhatsApp', 92, 'Almost done.'), 1600);
    };
    const fail = (msg) => { clearTimeout(stageTimer); overlay.hidden = true; btn.disabled = false; showFormError(msg); };
    xhr.onload = () => {
      clearTimeout(stageTimer);
      const r = xhr.response || {};
      if (xhr.status === 200 && r.ok) {
        setOverlay('Done', 100);
        setTimeout(() => { overlay.hidden = true; btn.disabled = false; showDone(r); }, reduceMotion ? 0 : 350);
      } else if (xhr.status === 409 && r.code === 'already_submitted') {
        overlay.hidden = true; btn.disabled = false;
        goTo(1, -1);
        showDuplicate(r.field, r.message);
      } else if (xhr.status === 422 && r.errors) {
        overlay.hidden = true; btn.disabled = false;
        const fields = Object.keys(r.errors);
        const step = Math.min(...fields.map(stepOf));
        goTo(step, -1);
        fields.forEach((f) => setError(f, r.errors[f]));
        showFormError('Some details need fixing. They are marked in red.');
      } else {
        fail(r.message || 'Could not submit right now. Try again in a minute.');
      }
    };
    xhr.onerror = () => fail('No internet connection. Your details are still here, so you can try again.');
    xhr.ontimeout = xhr.onerror;
    xhr.send(fd);
  }

  function showFormError(msg) {
    const box = $('#formError');
    box.textContent = msg;
    box.hidden = false;
  }

  // ---------- done ----------
  let pdfFile = null;
  let result = null;

  const TICK = '<svg viewBox="0 0 20 20"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>';
  const BANG = '<svg viewBox="0 0 20 20"><path d="M10 5v6M10 14.5v.5"/></svg>';

  function statusItem(ok, title, note) {
    const li = el('li', ok ? '' : 'is-warn');
    const icon = el('span', 'wa-icon');
    icon.innerHTML = ok ? TICK : BANG;
    const text = el('span');
    text.appendChild(document.createTextNode(title));
    if (note) text.appendChild(el('small', null, note));
    li.append(icon, text);
    return li;
  }

  function showDone(r) {
    submitted = true;
    result = r;
    $('#formView').hidden = true;
    $('#doneView').hidden = false;
    $$('.cl-list li').forEach((li) => { li.classList.add('is-done'); li.classList.remove('is-current'); });
    $('#doneCount').textContent = '8';

    $('#doneRef').textContent = r.ref;
    $('#doneFile').textContent = `${r.fileName} (${fmtSize(r.sizeBytes)})`;
    const dl = $('#downloadBtn');
    dl.href = r.downloadUrl;
    dl.setAttribute('download', r.fileName);

    const list = $('#waStatus');
    list.textContent = '';
    const wa = r.whatsapp || { configured: false, results: [] };
    const mail = r.email || { configured: false, results: [] };
    let waAdminOk = false;
    let mailAdminOk = false;
    for (const x of mail.results) {
      if (x.role === 'admin') {
        if (x.ok) mailAdminOk = true;
        list.appendChild(x.ok ? statusItem(true, 'Emailed to the UrCare admin', x.to) : statusItem(false, 'Could not email the admin', 'Use the WhatsApp or Share button below.'));
      } else {
        list.appendChild(x.ok ? statusItem(true, 'A copy was emailed to you', x.to) : statusItem(false, 'Could not email you a copy', 'Download the PDF below to keep a copy.'));
      }
    }
    for (const x of wa.results) {
      if (x.role === 'admin') {
        if (x.ok) waAdminOk = true;
        list.appendChild(x.ok ? statusItem(true, 'Sent to the UrCare admin on WhatsApp', x.to) : statusItem(false, 'Could not send to the admin on WhatsApp', 'Use Send to admin on WhatsApp below.'));
      } else {
        list.appendChild(x.ok ? statusItem(true, 'A copy was sent to your WhatsApp', x.to) : statusItem(false, 'Could not send a copy to your WhatsApp', 'Download the PDF below to keep a copy.'));
      }
    }
    if (!wa.configured && !mail.configured) list.appendChild(statusItem(false, 'Send this PDF to the UrCare admin', 'Use the WhatsApp or Share button below.'));
    // Offer the manual WhatsApp button when WhatsApp didn't reach the admin and email didn't cover it either
    const needWaButton = wa.configured ? !waAdminOk : !mailAdminOk;
    if (needWaButton) {
      const admin = config.adminWhatsapp;
      if (admin) {
        const name = val('fullName');
        const text = `Joining documents of ${name} (Ref ${r.ref}): ${r.fileUrl}`;
        const waBtn = $('#waAdminBtn');
        waBtn.href = `https://wa.me/${admin}?text=${encodeURIComponent(text)}`;
        waBtn.hidden = false;
      }
    }

    // Prepare the file now so the share sheet opens instantly on tap
    fetch(r.fileUrl)
      .then((res) => res.blob())
      .then((blob) => { pdfFile = new File([blob], r.fileName, { type: 'application/pdf' }); })
      .catch(() => {});

    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    $('#doneTitle').focus({ preventScroll: true });
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.textContent = ''; }, 3500);
  }

  async function copyLink() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.fileUrl);
    } catch (e) {
      const ta = el('textarea');
      ta.value = result.fileUrl;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (err) { /* ignore */ }
      ta.remove();
    }
    toast('Link copied. Paste it in WhatsApp, email or anywhere.');
  }

  $('#shareBtn').addEventListener('click', async () => {
    if (!result) return;
    const title = 'UrCare joining documents';
    const text = `Joining documents of ${val('fullName')} (Ref ${result.ref})`;
    try {
      if (pdfFile && navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
        await navigator.share({ files: [pdfFile], title, text });
      } else if (navigator.share) {
        await navigator.share({ title, text, url: result.fileUrl });
      } else {
        await copyLink();
      }
    } catch (e) {
      if (e && e.name !== 'AbortError') await copyLink();
    }
  });
  $('#copyBtn').addEventListener('click', copyLink);
  $('#againBtn').addEventListener('click', () => window.location.reload());

  window.addEventListener('beforeunload', (e) => {
    if (dirty && !submitted) { e.preventDefault(); e.returnValue = ''; }
  });

  goTo(1, 0);
  $('#panel').blur();
  updateChecklist();
})();
