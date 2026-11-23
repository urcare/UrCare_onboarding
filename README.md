# UrCare Onboarding

A simple green-and-white onboarding website for new UrCare employees, built from the
"Required documents for joining" sheet.

**What it does**

1. The employee fills a 5-step form that follows the 8 items on the sheet:
   Aadhaar, PAN, passport photo, resume, educational certificates, experience or fresher,
   bank passbook and IFSC, and address. The checklist on the side ticks off each item as it is completed.
2. They upload every document (photo or PDF). Photos are compressed and straightened in the browser.
3. On submit the server makes **one PDF**: a filled-in summary page (with the photo and a page index),
   followed by every uploaded document, with PDFs merged page by page.
4. The PDF is sent **automatically on WhatsApp** to the admin/doctor and to the employee,
   and **emailed to the admin's Gmail** with the PDF attached.
5. **One submission per person:** if the same mobile number or email is used again, the form stops
   on the first step and says it was already submitted.
6. The employee gets **Download PDF**, **Share PDF** (phone share sheet: WhatsApp, Gmail, anything),
   **Send to admin on WhatsApp** and **Copy link** buttons.

---

## Run it

Needs **Node.js 18 or newer**.

```bash
npm install
cp .env.example .env      # then fill in the values (see below)
npm start
```

Open http://localhost:3000

The site works without WhatsApp or email settings: the PDF is still made, and the employee
can download or share it. WhatsApp switches on when `AISENSY_API_KEY` and `AISENSY_CAMPAIGN_ADMIN` are set;
email switches on when `ADMIN_EMAIL`, `SMTP_USER` and `SMTP_PASS` are set.

---

## Email to the admin (Gmail)

1. Use a Gmail account to send from (for example a UrCare Gmail). Turn on **2-Step Verification** for it.
2. Open **Google Account > Security > 2-Step Verification > App passwords**, create one called "UrCare",
   and copy the 16-letter password.
3. In `.env`:

```
ADMIN_EMAIL=doctor@gmail.com          # who receives the PDF (comma-separate several)
SMTP_USER=urcare.forms@gmail.com      # the Gmail that sends
SMTP_PASS=abcd efgh ijkl mnop         # the App Password (not the normal password)
```

The email has the details and the full PDF attached (PDFs over 18 MB are sent as a link instead,
because Gmail limits attachments to 25 MB). Set `EMAIL_TO_EMPLOYEE=true` to also email the employee a copy.
Any other SMTP provider works too: change `SMTP_HOST` and `SMTP_PORT` (465 or 587).

---

## One submission per mobile number and email

Every submission is recorded in `storage/submissions.json`. If someone tries again with the same
mobile number **or** the same email, they see "Documents with this mobile number were submitted on ...
Each person can submit only once" on the first step, and the server refuses the upload as well.

To let someone submit again (for example after a wrong document):

```bash
npm run allow-resubmit -- 9876543210
npm run allow-resubmit -- name@gmail.com
```

Their old PDF stays in `storage/`.

---

## WhatsApp auto-send (AiSensy)

The PDF is sent on WhatsApp through an AiSensy API campaign.

1. In AiSensy, create a **Utility** template with a **Document** header, for example
   body: `New joining documents from {{1}} are attached. - UrCare`. Wait for approval.
2. **Campaigns > Launch > API Campaign**: pick that template and set the campaign live. Note its name.
3. **Manage > API Key**: copy the key.
4. In `.env`:

```
AISENSY_API_KEY=your_key
AISENSY_CAMPAIGN_ADMIN=your_campaign_name
AISENSY_CAMPAIGN_EMPLOYEE=          # optional, a second campaign for the employee copy
AISENSY_TEMPLATE_PARAMS=name        # values for {{1}}, {{2}}...: name, mobile, email, ref, designation, joiningDate
ADMIN_WHATSAPP=919876543210         # admin / doctor number(s), with 91, comma-separated
PUBLIC_URL=https://your-site.com    # REQUIRED: AiSensy downloads the PDF from this address
```

AiSensy fetches the PDF from a link, so the site must be reachable on the internet
(`PUBLIC_URL`). On `localhost` WhatsApp sending is skipped with a clear message.

If sending fails, the employee sees it on the success screen and gets a
**Send to admin on WhatsApp** button instead. Errors are also printed in the server log.

---

## Going live

- Host it anywhere that runs Node (a VPS, Render, Railway, etc.) **with HTTPS**.
- Set `PUBLIC_URL=https://your-domain` so shared links point to the live site.
- The `storage/` folder holds the PDFs: use a persistent disk and back it up.
- Set `DELETE_AFTER_DAYS` if PDFs should be removed automatically after some days.
  (`storage/submissions.json` is never deleted, so the one-submission rule keeps working.)

**Privacy:** these PDFs contain Aadhaar, PAN and bank details. Each PDF link has a long random
code, but anyone who has the link can open it, so share links only with the right people.
Never commit `.env` or `storage/` to git (they are already in `.gitignore`).

---

## Files

```
server.js            Web server and API (/api/submit, /files/..., static site)
lib/validate.js      Checks every field and file (type, size, locked PDFs, Aadhaar checksum)
lib/pdf.js           Builds the combined PDF (pdf-lib)
lib/whatsapp.js      Sends the PDF on WhatsApp via AiSensy
lib/mailer.js        Emails the PDF (Gmail / any SMTP), no extra package needed
lib/registry.js      Remembers who already submitted (storage/submissions.json)
scripts/             allow-resubmit.js
lib/env.js           Reads .env
public/              The website (HTML, CSS, JS, logo, fonts)
server-assets/       Logo used inside the PDF
storage/             Generated PDFs
```

**Change things:**
- Colours: the `:root` block at the top of `public/css/style.css`
- Text and fields: `public/index.html` (and the rules in `public/js/app.js` + `lib/validate.js`)
- PDF layout: `lib/pdf.js`

Notes: text in the PDF uses English letters (the form asks for English).
Password-protected PDFs, such as downloaded e-Aadhaar files, are rejected with a message asking
for a photo or an unlocked copy, because they cannot be merged.
Fonts: Montserrat and Source Sans 3, SIL Open Font License (see `public/fonts`).

---

## Marksheet auto-read (Groq)

When an employee uploads a 10th / 12th / graduation marksheet or certificate, the site reads it
with a Groq vision model and fills in **Your qualifications** for them (for example
`Class 12 (Science), CBSE, 2020, 82.4%`). They can still edit the text. PDFs are read from their first page.

1. Create a key at https://console.groq.com/keys
2. In `.env`: `GROQ_API_KEY=gsk_...`
3. Restart the server. The start-up log shows `Marksheet auto-read (Groq): ON`.

Without the key the form works as before and the employee types the details.
`GROQ_MODEL` changes the vision model if Groq retires the default one.
