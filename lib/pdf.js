// Builds ONE combined PDF: a summary page (the joining checklist, filled in)
// followed by every uploaded document (images as pages, PDFs merged page by page).
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const A4 = [595.28, 841.89];
const M = 44; // page margin

const C = {
  leaf: rgb(0.122, 0.616, 0.286), // #1F9D49
  deep: rgb(0.078, 0.424, 0.204), // #146C34
  ink: rgb(0.071, 0.196, 0.133), // #123222
  moss: rgb(0.345, 0.439, 0.392), // #587064
  mint: rgb(0.925, 0.973, 0.941), // #ECF8F0
  line: rgb(0.827, 0.914, 0.855), // #D3E9DA
  white: rgb(1, 1, 1),
};

const LOGO_PATH = path.join(__dirname, '..', 'server-assets', 'logo.png');

const SECTION_ORDER = [
  ['photo', 'Passport size photograph'],
  ['aadhaarFiles', 'Aadhaar card'],
  ['panFile', 'PAN card'],
  ['resumeFile', 'Resume / CV'],
  ['educationFiles', 'Educational certificate'],
  ['experienceFiles', 'Experience letter'],
  ['passbookFile', 'Bank passbook / cheque'],
];

function istNow() {
  const d = new Date();
  const date = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
  return { date, time };
}

function fmtDate(iso) {
  if (!iso) return 'Not given';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
}

/** Expand uploaded files into an ordered list of attachments with page counts. */
async function planAttachments(files) {
  const list = [];
  for (const [field, label] of SECTION_ORDER) {
    const group = files[field] || [];
    for (let i = 0; i < group.length; i++) {
      const f = group[i];
      const title = group.length > 1 ? `${label} (${i + 1} of ${group.length})` : label;
      if (f.type === 'application/pdf') {
        let src = null;
        try {
          src = await PDFDocument.load(f.buffer, { ignoreEncryption: true, updateMetadata: false });
          if (src.isEncrypted) src = null;
        } catch (e) {
          src = null;
        }
        list.push({ field, title, file: f, kind: src ? 'pdf' : 'broken', src, pages: src ? src.getPageCount() : 1 });
      } else {
        list.push({ field, title, file: f, kind: 'image', pages: 1 });
      }
    }
  }
  return list;
}

function makeCleaner(font) {
  const ok = new Set(font.getCharacterSet());
  return (s) =>
    String(s ?? '')
      .replace(/\r\n?/g, '\n')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\t/g, ' ')
      .split('')
      .map((ch) => (ch === '\n' || ok.has(ch.codePointAt(0)) ? ch : '?'))
      .join('');
}

function wrap(text, font, size, maxWidth) {
  const out = [];
  for (const para of String(text).split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = '';
    for (let word of words) {
      // hard-break words wider than the line
      while (font.widthOfTextAtSize(word, size) > maxWidth) {
        let cut = word.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(word.slice(0, cut), size) > maxWidth) cut--;
        if (line) { out.push(line); line = ''; }
        out.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      const test = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) <= maxWidth) line = test;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
  }
  return out;
}

async function embedImage(doc, file) {
  return file.type === 'image/png' ? doc.embedPng(file.buffer) : doc.embedJpg(file.buffer);
}

/**
 * Draws the summary pages into `doc`. Returns the pages it created.
 */
async function drawSummary(doc, ctx) {
  const { data, ref, when, attachments, fonts, clean, logo } = ctx;
  const { regular: F, bold: B } = fonts;
  const [W, H] = A4;
  const pages = [];
  let page;
  let y;

  const newPage = (continued) => {
    page = doc.addPage(A4);
    pages.push(page);
    y = H - M;
    // header: logo + tagline + rule
    const lh = 34;
    const lw = (logo.width / logo.height) * lh;
    page.drawImage(logo, { x: M - 4, y: y - lh + 4, width: lw, height: lh });
    const tag = 'We are always with you';
    page.drawText(tag, { x: W - M - F.widthOfTextAtSize(tag, 10), y: y - 16, size: 10, font: F, color: C.leaf });
    y -= lh + 10;
    page.drawRectangle({ x: M, y, width: W - 2 * M, height: 2, color: C.leaf });
    y -= 26;
    if (continued) {
      page.drawText(clean(`Joining documents of ${data.fullName} (continued)`), { x: M, y, size: 11, font: B, color: C.ink });
      y -= 24;
    }
  };

  const ensure = (h) => { if (y - h < M + 30) newPage(true); };

  const sectionTitle = (t) => {
    ensure(40);
    page.drawText(t, { x: M, y, size: 12.5, font: B, color: C.deep });
    y -= 10;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: C.line });
    y -= 16;
  };

  // ---------- Page 1 ----------
  newPage(false);
  page.drawText('Required documents for joining', { x: M, y, size: 19, font: B, color: C.ink });
  y -= 20;
  page.drawText(clean(`Submitted by ${data.fullName} on ${when.date}, ${when.time} IST`), { x: M, y, size: 10, font: F, color: C.moss });
  y -= 14;
  page.drawText(`Reference: ${ref}`, { x: M, y, size: 10, font: B, color: C.moss });
  y -= 28;

  sectionTitle('Personal details');
  const blockTop = y + 4;
  // Personal details block with passport photo on the right
  const photoFile = (ctx.files.photo || [])[0];
  const photoW = 92;
  const photoH = 114;
  if (photoFile) {
    const img = await embedImage(doc, photoFile);
    const fit = Math.min(photoW / img.width, photoH / img.height);
    const fw = img.width * fit;
    const fh = img.height * fit;
    const px = W - M - photoW - 4;
    const py = blockTop - photoH + 8;
    page.drawRectangle({ x: px - 4, y: py - 4, width: photoW + 8, height: photoH + 8, color: C.mint, borderColor: C.line, borderWidth: 1 });
    page.drawImage(img, { x: px + (photoW - fw) / 2, y: py + (photoH - fh) / 2, width: fw, height: fh });
  }

  const labelW = 150;
  const detailMaxW = W - 2 * M - labelW - (photoFile ? photoW + 24 : 0);
  const detailRows = [
    ['Full name', data.fullName],
    ['Mobile (WhatsApp)', `+91 ${data.mobile.slice(0, 5)} ${data.mobile.slice(5)}`],
    ['Email', data.email || 'Not given'],
    ['Designation', data.designation || 'Not given'],
    ['Date of joining', fmtDate(data.joiningDate)],
  ];
  for (const [k, v] of detailRows) {
    const lines = wrap(clean(v), F, 10.5, detailMaxW);
    page.drawText(k, { x: M, y, size: 10, font: F, color: C.moss });
    lines.forEach((ln, i) => page.drawText(ln, { x: M + labelW, y: y - i * 14, size: 10.5, font: B, color: C.ink }));
    y -= Math.max(1, lines.length) * 14 + 6;
  }
  y = Math.min(y, blockTop - photoH - 18);
  y -= 8;

  // The 8 items, exactly as on the paper form
  const att = (field) => attachments.filter((a) => a.field === field);
  const pagesOf = (field) => {
    const items = att(field);
    if (!items.length) return '';
    const first = items[0].startPage;
    const last = items[items.length - 1].startPage + items[items.length - 1].pages - 1;
    return first === last ? `page ${first}` : `pages ${first}-${last}`;
  };
  const aad = data.aadhaarNumber.replace(/(\d{4})(\d{4})(\d{4})/, '$1 $2 $3');
  const items = [
    ['Aadhaar Card', aad, pagesOf('aadhaarFiles')],
    ['PAN Card', data.panNumber, pagesOf('panFile')],
    ['Passport Size Photographs', 'Attached', pagesOf('photo')],
    ['Resume / CV', data.hasResume === 'yes' ? 'Yes' : 'No', pagesOf('resumeFile')],
    ['Educational Certificates details', `${data.educationDetails}\n${att('educationFiles').length} certificate(s) attached`, pagesOf('educationFiles')],
    [
      'Experience / Fresher',
      data.workStatus === 'experienced'
        ? `Experience: ${data.experienceYears} year(s), last company ${data.lastCompany}${att('experienceFiles').length ? '' : '\nNo experience letter uploaded'}`
        : 'Fresher',
      pagesOf('experienceFiles'),
    ],
    ['Bank Passbook Ac', `A/c ${data.bankAccount}\nIFSC code ${data.ifsc}`, pagesOf('passbookFile')],
    ['Address', data.address, ''],
  ];

  sectionTitle('Personal documents');
  const numX = M;
  const lblX = M + 26;
  const valX = M + 200;
  const refColW = 78;
  const valW = W - M - valX - refColW;
  items.forEach(([label, value, where], i) => {
    const lines = wrap(clean(value), F, 10.5, valW);
    const lblLines = wrap(label, B, 10.5, valX - lblX - 10);
    const rowH = Math.max(lines.length, lblLines.length) * 14 + 8;
    ensure(rowH + 4);
    // number badge
    page.drawCircle({ x: numX + 9, y: y + 3.5, size: 9, color: C.mint, borderColor: C.leaf, borderWidth: 1 });
    const n = String(i + 1);
    page.drawText(n, { x: numX + 9 - B.widthOfTextAtSize(n, 9) / 2, y: y, size: 9, font: B, color: C.deep });
    lblLines.forEach((ln, j) => page.drawText(ln, { x: lblX, y: y - j * 14, size: 10.5, font: B, color: C.ink }));
    lines.forEach((ln, j) => page.drawText(ln, { x: valX, y: y - j * 14, size: 10.5, font: F, color: C.ink }));
    if (where) page.drawText(where, { x: W - M - F.widthOfTextAtSize(where, 9), y, size: 9, font: F, color: C.leaf });
    y -= rowH - 4;
    page.drawLine({ start: { x: lblX, y: y + 2 }, end: { x: W - M, y: y + 2 }, thickness: 0.5, color: C.line, dashArray: [2, 2] });
    y -= 10;
  });

  // Index of attachments
  y -= 6;
  sectionTitle('Attached documents');
  ensure(20);
  page.drawText('Document', { x: M, y, size: 9, font: B, color: C.moss });
  page.drawText('File', { x: M + 210, y, size: 9, font: B, color: C.moss });
  page.drawText('Page', { x: W - M - 30, y, size: 9, font: B, color: C.moss });
  y -= 15;
  for (const a of attachments) {
    ensure(16);
    page.drawText(clean(a.title), { x: M, y, size: 10, font: F, color: C.ink });
    const fname = wrap(clean(a.file.name), F, 9, W - 2 * M - 210 - 50)[0] || '';
    page.drawText(fname, { x: M + 210, y, size: 9, font: F, color: C.moss });
    const p = a.pages > 1 ? `${a.startPage}-${a.startPage + a.pages - 1}` : String(a.startPage);
    page.drawText(p, { x: W - M - 30, y, size: 10, font: B, color: C.deep });
    y -= 15;
  }

  // Declaration + office use
  y -= 14;
  ensure(96);
  const decl = wrap(
    clean(`I, ${data.fullName}, confirm that the details and documents in this file are true and belong to me.`),
    F, 10, W - 2 * M - 28
  );
  const boxH = decl.length * 13 + 66;
  page.drawRectangle({ x: M, y: y - boxH + 14, width: W - 2 * M, height: boxH, color: C.mint, borderColor: C.line, borderWidth: 1 });
  let yy = y - 4;
  decl.forEach((ln) => { page.drawText(ln, { x: M + 14, y: yy, size: 10, font: F, color: C.ink }); yy -= 13; });
  yy -= 14;
  page.drawText('For office use', { x: M + 14, y: yy, size: 9.5, font: B, color: C.deep });
  yy -= 18;
  page.drawText('Verified by: ____________________', { x: M + 14, y: yy, size: 9.5, font: F, color: C.moss });
  page.drawText('Date: ______________', { x: M + 270, y: yy, size: 9.5, font: F, color: C.moss });
  y -= boxH + 6;

  return pages;
}

/**
 * @returns {Promise<Uint8Array>}
 */
async function buildOnboardingPdf({ data, files, ref }) {
  const when = istNow();
  const attachments = await planAttachments(files);

  const setup = async (doc) => {
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const logo = await doc.embedPng(fs.readFileSync(LOGO_PATH));
    return { fonts: { regular, bold }, clean: makeCleaner(regular), logo };
  };

  // Dry run to learn how many summary pages there will be, so the index shows real page numbers.
  const scratch = await PDFDocument.create();
  const s1 = await setup(scratch);
  attachments.forEach((a) => (a.startPage = 0));
  const summaryCount = (await drawSummary(scratch, { data, files, ref, when, attachments, ...s1 })).length;

  let pageNo = summaryCount + 1;
  for (const a of attachments) { a.startPage = pageNo; pageNo += a.pages; }

  const doc = await PDFDocument.create();
  doc.setTitle(`UrCare joining documents - ${data.fullName}`);
  doc.setAuthor('UrCare onboarding');
  doc.setSubject(`Reference ${ref}`);
  doc.setCreator('UrCare onboarding');
  const s2 = await setup(doc);
  const { regular: F, bold: B } = s2.fonts;
  const clean = s2.clean;

  const ownPages = await drawSummary(doc, { data, files, ref, when, attachments, ...s2 });

  const [W, H] = A4;
  for (const a of attachments) {
    if (a.kind === 'image') {
      const page = doc.addPage(A4);
      ownPages.push(page);
      let y = H - M;
      page.drawText(clean(a.title), { x: M, y: y - 4, size: 14, font: B, color: C.ink });
      const fname = wrap(clean(a.file.name), F, 9, 220)[0] || '';
      page.drawText(fname, { x: W - M - F.widthOfTextAtSize(fname, 9), y: y - 2, size: 9, font: F, color: C.moss });
      y -= 16;
      page.drawRectangle({ x: M, y, width: W - 2 * M, height: 1.5, color: C.leaf });
      const img = await embedImage(doc, a.file);
      const boxW = W - 2 * M;
      const boxH = y - 20 - (M + 24);
      const s = Math.min(boxW / img.width, boxH / img.height, a.field === 'photo' ? 1.6 : 4);
      const iw = img.width * s;
      const ih = img.height * s;
      const ix = M + (boxW - iw) / 2;
      const iy = y - 20 - ih;
      page.drawRectangle({ x: ix - 1, y: iy - 1, width: iw + 2, height: ih + 2, borderColor: C.line, borderWidth: 1 });
      page.drawImage(img, { x: ix, y: iy, width: iw, height: ih });
    } else if (a.kind === 'pdf') {
      const copied = await doc.copyPages(a.src, a.src.getPageIndices());
      copied.forEach((p, i) => {
        doc.addPage(p);
        if (p.getRotation().angle % 360 !== 0) return; // keep rotated scans untouched
        const box = p.getCropBox();
        const label = clean(`${a.title}${a.pages > 1 ? `, page ${i + 1} of ${a.pages}` : ''}`);
        const k = Math.max(1, Math.min(box.width, box.height) / 595); // keep the label readable on oversized pages
        const fs = 8 * k;
        const tw = B.widthOfTextAtSize(label, fs);
        const lx = box.x + 10 * k;
        const ly = box.y + box.height - 22 * k;
        p.drawRectangle({ x: lx, y: ly, width: tw + 14 * k, height: 15 * k, color: C.white, opacity: 0.92, borderColor: C.leaf, borderWidth: 0.8 * k });
        p.drawText(label, { x: lx + 7 * k, y: ly + 4.5 * k, size: fs, font: B, color: C.deep });
      });
    } else {
      const page = doc.addPage(A4);
      ownPages.push(page);
      page.drawText(clean(a.title), { x: M, y: H - M - 4, size: 14, font: B, color: C.ink });
      const msg = wrap(clean(`The file "${a.file.name}" could not be merged because it is damaged or locked. Ask ${data.fullName} for a clear photo or an unlocked PDF.`), F, 11, W - 2 * M);
      msg.forEach((ln, i) => page.drawText(ln, { x: M, y: H - M - 40 - i * 15, size: 11, font: F, color: C.moss }));
    }
  }

  // Footer on our own pages
  const total = doc.getPageCount();
  const pagesArr = doc.getPages();
  for (const p of ownPages) {
    const idx = pagesArr.indexOf(p) + 1;
    const left = `UrCare onboarding  |  ${ref}`;
    const right = `Page ${idx} of ${total}`;
    p.drawLine({ start: { x: M, y: M + 6 }, end: { x: W - M, y: M + 6 }, thickness: 0.5, color: C.line });
    p.drawText(left, { x: M, y: M - 8, size: 8.5, font: F, color: C.moss });
    p.drawText(right, { x: W - M - F.widthOfTextAtSize(right, 8.5), y: M - 8, size: 8.5, font: F, color: C.moss });
  }

  return doc.save();
}

module.exports = { buildOnboardingPdf };
