// Server-side validation of the onboarding form (mirrors the checks in public/js/app.js).

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file

// file field -> { label, min, max }
const FILE_FIELDS = {
  photo: { label: 'Passport size photograph', min: 1, max: 1, imagesOnly: true },
  aadhaarFiles: { label: 'Aadhaar card', min: 1, max: 2 },
  panFile: { label: 'PAN card', min: 1, max: 1 },
  resumeFile: { label: 'Resume / CV', min: 0, max: 1 },
  educationFiles: { label: 'Educational certificates', min: 1, max: 8 },
  experienceFiles: { label: 'Experience letter', min: 0, max: 4 },
  passbookFile: { label: 'Bank passbook / cancelled cheque', min: 1, max: 1 },
};

// Verhoeff checksum, used by every valid Aadhaar number.
const V_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const V_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
function verhoeffValid(num) {
  let c = 0;
  const digits = String(num).split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i++) c = V_D[c][V_P[i % 8][digits[i]]];
  return c === 0;
}

function detectType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 5 && buf.slice(0, 1024).includes(Buffer.from('%PDF-'))) return 'application/pdf';
  return null;
}

const str = (v, max = 1000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * @param {FormData} form - parsed multipart form
 * @returns {Promise<{ data, files, errors }>}
 */
async function validateSubmission(form) {
  const errors = {};
  const get = (k, max) => str(form.get(k), max);

  const data = {
    fullName: get('fullName', 80),
    mobile: get('mobile', 20).replace(/\D/g, ''),
    email: get('email', 120),
    designation: get('designation', 80),
    joiningDate: get('joiningDate', 10),
    aadhaarNumber: get('aadhaarNumber', 20).replace(/\D/g, ''),
    panNumber: get('panNumber', 10).toUpperCase(),
    hasResume: get('hasResume', 3),
    educationDetails: get('educationDetails', 600),
    workStatus: get('workStatus', 12),
    experienceYears: get('experienceYears', 5),
    lastCompany: get('lastCompany', 100),
    bankAccount: get('bankAccount', 20).replace(/\s/g, ''),
    ifsc: get('ifsc', 11).toUpperCase(),
    address: get('address', 400),
    declaration: get('declaration', 3),
  };

  if (data.mobile.length === 12 && data.mobile.startsWith('91')) data.mobile = data.mobile.slice(2);

  if (!/^[A-Za-z][A-Za-z .'-]{1,79}$/.test(data.fullName)) errors.fullName = 'Enter your full name in English letters.';
  if (!/^[6-9]\d{9}$/.test(data.mobile)) errors.mobile = 'Enter a 10-digit Indian mobile number.';
  data.email = data.email.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email)) errors.email = 'Enter a valid email address.';
  if (data.joiningDate && !/^\d{4}-\d{2}-\d{2}$/.test(data.joiningDate)) errors.joiningDate = 'Pick a valid date.';

  if (!/^[2-9]\d{11}$/.test(data.aadhaarNumber) || !verhoeffValid(data.aadhaarNumber)) {
    errors.aadhaarNumber = 'Enter a valid 12-digit Aadhaar number.';
  }
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(data.panNumber)) errors.panNumber = 'Enter a valid PAN, like ABCDE1234F.';

  if (!['yes', 'no'].includes(data.hasResume)) errors.hasResume = 'Choose yes or no.';
  if (data.educationDetails.length < 3) errors.educationDetails = 'Write your qualifications.';

  if (!['experienced', 'fresher'].includes(data.workStatus)) errors.workStatus = 'Choose experience or fresher.';
  if (data.workStatus === 'experienced') {
    const yrs = Number(data.experienceYears);
    if (!(yrs > 0 && yrs <= 50)) errors.experienceYears = 'Enter your total experience in years.';
    if (data.lastCompany.length < 2) errors.lastCompany = 'Enter your last company name.';
  } else {
    data.experienceYears = '';
    data.lastCompany = '';
  }

  if (!/^\d{9,18}$/.test(data.bankAccount)) errors.bankAccount = 'Enter a 9 to 18 digit account number.';
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(data.ifsc)) errors.ifsc = 'Enter a valid 11-character IFSC code.';
  if (data.address.length < 10) errors.address = 'Enter your full address with PIN code.';
  if (data.declaration !== 'yes') errors.declaration = 'Please confirm the declaration.';

  // Files
  const files = {};
  for (const [field, rule] of Object.entries(FILE_FIELDS)) {
    const entries = form.getAll(field).filter((f) => f && typeof f === 'object' && f.size > 0);
    let min = rule.min;
    if (field === 'resumeFile' && data.hasResume === 'yes') min = 1;
    if (field === 'resumeFile' && data.hasResume !== 'yes') { files[field] = []; continue; }
    if (field === 'experienceFiles' && data.workStatus !== 'experienced') { files[field] = []; continue; }

    if (entries.length < min) { errors[field] = `Upload your ${rule.label.toLowerCase()}.`; continue; }
    if (entries.length > rule.max) { errors[field] = `Upload at most ${rule.max} file(s) for ${rule.label.toLowerCase()}.`; continue; }

    files[field] = [];
    for (const file of entries) {
      if (file.size > MAX_FILE_BYTES) { errors[field] = `${file.name} is larger than 10 MB.`; break; }
      const buffer = Buffer.from(await file.arrayBuffer());
      const type = detectType(buffer);
      if (!type || (rule.imagesOnly && type === 'application/pdf')) {
        errors[field] = rule.imagesOnly ? 'Photo must be a JPG or PNG image.' : `${file.name} must be a JPG, PNG or PDF.`;
        break;
      }
      if (type === 'application/pdf' && buffer.includes(Buffer.from('/Encrypt'))) {
        errors[field] = `${file.name} is password-protected. Upload a photo or an unlocked PDF.`;
        break;
      }
      files[field].push({ name: file.name || 'document', type, buffer });
    }
  }

  return { data, files, errors };
}

module.exports = { validateSubmission, FILE_FIELDS, MAX_FILE_BYTES, verhoeffValid };
