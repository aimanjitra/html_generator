// server.js
// DeepSeek + uploaded DOCX/PDF -> Full HTML generator
// Uses: express, multer (diskStorage to preserve ext), cheerio, mammoth, optional pdf-parse, adm-zip, sanitize-html
//
// npm install express multer cheerio mammoth sanitize-html node-fetch adm-zip
// optional: npm i pdf-parse

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const sanitizeHtml = require('sanitize-html');
const mammoth = require('mammoth');
const AdmZip = require('adm-zip');

const app = express();
app.use(cors());
app.use(express.json());

// ------------------ CONFIG ------------------
// Uploads directory
const UPLOAD_DIR = path.resolve(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// DEFAULT fallback file path (change to whichever file you want by default)
// Developer note: using the path observed in your uploads history.
const DEFAULT_UPLOADED_FILE_PATH = '/mnt/data/aasss.pdf';

// Optional pdf-parse (install only if you need PDF extraction)
let pdfParse;
try {
  pdfParse = require('pdf-parse');
  console.log('pdf-parse is available: PDF extraction enabled.');
} catch (e) {
  console.log('pdf-parse not installed — PDF extraction will be skipped unless you `npm i pdf-parse`.');
}

// ------------------ multer: preserve original extension ------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // use timestamp + original extension to preserve .pdf/.docx/.doc etc
    const ext = path.extname(file.originalname) || '';
    cb(null, `${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

// ------------------ helpers ------------------
function cleanText(t) {
  if (!t) return '';
  return sanitizeHtml(t, { allowedTags: [], allowedAttributes: {} }).replace(/\r/g, '').trim();
}

async function fetchDeepseekText(url) {
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 });
    if (!resp.ok) throw new Error('DeepSeek page not accessible: ' + resp.status);
    const html = await resp.text();
    const $ = cheerio.load(html);

    $('script, style, noscript, iframe').remove();
    $('*').each((i, el) => {
      const attribs = el.attribs || {};
      for (const a of Object.keys(attribs)) if (/on\w+/i.test(a)) $(el).removeAttr(a);
    });

    const selectors = ['article', '.chat', '.message', '.prose', '#root', 'main', '.chat-message', '.message-content'];
    let collected = '';

    for (const sel of selectors) {
      const el = $(sel);
      if (el && el.length) {
        el.each((i, node) => {
          const txt = cleanText($(node).text());
          if (txt.length > 25) collected += txt + '\n\n';
        });
      }
      if (collected.length > 400) break;
    }

    if (!collected || collected.length < 200) {
      const bodyText = cleanText($('body').text()).replace(/\s{2,}/g, '\n').trim();
      const noise = ['Share', 'Copied', 'OpenAI', 'Sign in', 'Sign up', 'DeepSeek', 'Home', 'About', 'cookie', 'cdn-cgi', '__CF$'];
      collected = bodyText.split('\n').filter(line => {
        const s = line.trim();
        if (s.length < 4) return false;
        for (const n of noise) if (s.includes(n)) return false;
        return true;
      }).join('\n');
    }

    collected = collected.split('\n').filter(l => {
      if (/function\s*\(|document\.|cdn-cgi|__CF\$|eval\(/i.test(l)) return false;
      if (l.length > 200 && !/\s/.test(l)) return false;
      return l.trim().length > 0;
    }).join('\n').replace(/\n{3,}/g, '\n\n').trim();

    return collected;
  } catch (err) {
    console.error('fetchDeepseekText error:', err && err.message);
    return '';
  }
}

// Try to extract docx using mammoth (pass Buffer)
async function extractTextFromDocx(localPath) {
  try {
    const buffer = fs.readFileSync(localPath); // buffer, not utf8 string
    const result = await mammoth.extractRawText({ buffer });
    const text = (result && result.value) ? result.value : '';
    return cleanText(text);
  } catch (err) {
    console.warn('mammoth extraction failed:', err && err.message);
    return '';
  }
}

// adm-zip fallback for DOCX: read word/document.xml and strip tags
function extractTextFromDocxZipFallback(localPath) {
  try {
    const zip = new AdmZip(localPath);
    const entry = zip.getEntry('word/document.xml');
    if (!entry) {
      console.warn('zip fallback: word/document.xml not found');
      return '';
    }
    const xml = entry.getData().toString('utf8');
    const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return cleanText(text);
  } catch (err) {
    console.warn('zip fallback failed:', err && err.message);
    return '';
  }
}

// PDF extraction (optional)
async function extractTextFromPdf(localPath) {
  if (!pdfParse) return '';
  try {
    const buffer = fs.readFileSync(localPath);
    const data = await pdfParse(buffer);
    return (data && data.text) ? cleanText(data.text) : '';
  } catch (err) {
    console.warn('pdf-parse extraction failed:', err && err.message);
    return '';
  }
}

// ------------------ upload endpoint ------------------
app.post('/upload-cv', upload.single('cv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    // send back the exact full path on server (with extension preserved)
    const localPath = path.resolve(req.file.path);
    return res.json({
      ok: true,
      filename: req.file.filename,
      originalname: req.file.originalname,
      localPath
    });
  } catch (err) {
    console.error('upload error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ------------------ CV parsing & HTML generation ------------------
function parseCvSections(text) {
  const trimmed = (text || '').replace(/\r/g, '').trim();
  const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);

  let name = 'Candidate Name';
  for (let i = 0; i < Math.min(6, lines.length); i++) {
    const l = lines[i];
    if (/function\s*\(|document\.|cdn-cgi|__CF\$|https?:\/\//i.test(l)) continue;
    if (l.length > 3 && l.split(' ').length <= 8) { name = l; break; }
  }

  const nameIndex = lines.findIndex(l => l === name);
  const summary = lines.slice(nameIndex + 1, nameIndex + 6).join(' ') || '';

  const lower = lines.map(l => l.toLowerCase());
  function extract(headers) {
    const idx = lower.findIndex(l => headers.some(h => l.startsWith(h) || l.includes(h)));
    if (idx === -1) return '';
    let end = lines.length;
    for (let j = idx + 1; j < lower.length; j++) {
      if (['experience','education','skills','projects','achievements','certificat','contact','summary'].some(h => lower[j].includes(h))) { end = j; break; }
    }
    return lines.slice(idx + 1, end).join('\n');
  }

  const sections = {
    raw: text,
    name,
    summary,
    experience: extract(['experience', 'work experience', 'employment']),
    education: extract(['education', 'academic', 'degree']),
    skills: extract(['skills', 'technical skills', 'skill']),
    projects: extract(['projects', 'project']),
    achievements: extract(['achievements', 'awards', 'honours']),
    contact: extract(['contact', 'email', 'phone', 'linkedin'])
  };

  if (!sections.experience && lines.length > 6) sections.experience = lines.slice(6, Math.min(lines.length, 60)).join('\n');
  if (!sections.summary && lines.length > 1) sections.summary = lines.slice(1, 6).join(' ');
  return sections;
}

function generateFullHtml(sections, themeType = 'modern', themeColors = 'black', professional = true) {
  const esc = s => sanitizeHtml(String(s || ''), { allowedTags: [], allowedAttributes: {} }).replace(/\n/g, '<br>');
  const primary = (themeColors || '').split(/\s+/)[0] || '#111111';
  const accent = '#6c5ce7';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(sections.name)} — CV Website</title>
<style>
:root{--primary:${primary};--accent:${accent};--bg:#ffffff;--text:#222}
body{font-family:Inter, Arial, sans-serif;background:#f6f8fb;margin:0;padding:24px;color:var(--text)}
.wrap{max-width:980px;margin:36px auto;background:var(--bg);border-radius:12px;padding:28px;box-shadow:0 10px 30px rgba(20,20,40,.06)}
header{display:flex;gap:18px;align-items:center;border-bottom:1px solid #eee;padding-bottom:18px;margin-bottom:20px}
.avatar{width:96px;height:96px;border-radius:14px;background:linear-gradient(135deg,var(--accent),var(--primary));display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:28px}
h1{margin:0;font-size:28px}
.meta{color:#666;margin-top:6px}
.section{margin-bottom:20px}
.section h2{margin:0 0 8px 0;color:var(--primary);font-size:18px}
.card{background:#fbfbff;padding:12px;border-radius:10px;border:1px solid #f0f0ff}
.skill-chip{display:inline-block;padding:6px 10px;margin:6px 6px 0 0;border-radius:999px;background:#f2f3ff;font-size:13px}
pre{white-space:pre-wrap;font-family:inherit}
footer{border-top:1px solid #eee;padding-top:12px;color:#777;font-size:13px;margin-top:28px}
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="avatar">${(sections.name && sections.name[0]) || 'A'}</div>
      <div>
        <h1>${esc(sections.name)}</h1>
        <div class="meta">${esc(sections.summary)}</div>
      </div>
    </header>

    <div class="section">
      <h2>Experience</h2>
      <div class="card"><pre>${esc(sections.experience || 'No experience section found.')}</pre></div>
    </div>

    <div class="section">
      <h2>Projects</h2>
      <div class="card"><pre>${esc(sections.projects || 'No projects listed.')}</pre></div>
    </div>

    <div class="section">
      <h2>Education</h2>
      <div class="card"><pre>${esc(sections.education || 'No education section found.')}</pre></div>
    </div>

    <div class="section">
      <h2>Achievements</h2>
      <div class="card"><pre>${esc(sections.achievements || 'No achievements listed.')}</pre></div>
    </div>

    <div class="section">
      <h2>Skills</h2>
      <div class="card">${sections.skills ? sections.skills.split(/[,\n]+/).map(s => '<span class="skill-chip">' + esc(s.trim()) + '</span>').join('') : 'No skills found'}</div>
    </div>

    <footer>Generated by HTML-Generator · Theme: ${sanitizeHtml(String(themeType))} · Colors: ${sanitizeHtml(String(themeColors))} · Professional: ${professional}</footer>
  </div>
</body>
</html>`;
}

// ------------------ /generate endpoint ------------------
app.post('/generate', async (req, res) => {
  try {
    const {
      deepseekUrl = '',
      themeType = 'modern',
      themeColors = 'black',
      professional = true,
      uploadedFilePath = DEFAULT_UPLOADED_FILE_PATH
    } = req.body || {};

    console.log('generate request payload:', { deepseekUrl, themeType, themeColors, professional, uploadedFilePath });

    let cvText = '';

    // 1) DeepSeek first
    if (deepseekUrl) {
      cvText = await fetchDeepseekText(deepseekUrl);
      console.log('DeepSeek extracted length:', cvText.length);
    }

    // 2) If not enough text, attempt DOCX extraction (mammoth) if file present
    if ((!cvText || cvText.length < 120) && uploadedFilePath && fs.existsSync(uploadedFilePath)) {
      const ext = path.extname(uploadedFilePath).toLowerCase();
      if (ext === '.docx') {
        console.log('Attempting DOCX extraction (mammoth) from', uploadedFilePath);
        const docxText = await extractTextFromDocx(uploadedFilePath);
        if ((!cvText || docxText.length > cvText.length) && docxText && docxText.length > 20) cvText = docxText;

        if ((!cvText || cvText.length < 80)) {
          console.log('Mammoth returned little text; trying zip fallback...');
          const fallback = extractTextFromDocxZipFallback(uploadedFilePath);
          if (fallback && fallback.length > cvText.length) cvText = fallback;
        }
      } else if (ext === '.doc') {
        // .doc is the older binary Word format. Mammoth does not parse it reliably.
        // Best practice: convert .doc -> .docx (LibreOffice) on the server, then run mammoth.
        // You can optionally enable automatic conversion with LibreOffice CLI if available:
        //
        // Example (optional):
        // const { execSync } = require('child_process');
        // const converted = uploadedFilePath + '.converted.docx';
        // execSync(`soffice --headless --convert-to docx --outdir ${path.dirname(uploadedFilePath)} ${uploadedFilePath}`);
        // then set uploadedFilePath = path.join(path.dirname(uploadedFilePath), '<converted-filename>.docx')
        //
        console.log('.doc uploaded: convert to .docx (LibreOffice) for best results or ask user to upload .docx.');
      }
    }

    // 3) PDF fallback (pdf-parse) or try reading raw text
    if ((!cvText || cvText.length < 120) && uploadedFilePath && fs.existsSync(uploadedFilePath)) {
      const ext = path.extname(uploadedFilePath).toLowerCase();
      if (ext === '.pdf' && pdfParse) {
        console.log('Attempting PDF extraction from', uploadedFilePath);
        const pdfText = await extractTextFromPdf(uploadedFilePath);
        if (pdfText && pdfText.length > cvText.length) cvText = pdfText;
      } else {
        // try reading plain text (for plain text or server-saved HTML)
        try {
          const raw = fs.readFileSync(uploadedFilePath, 'utf8');
          if (raw && raw.length > cvText.length) cvText = cleanText(raw);
        } catch (e) {
          // unreadable as utf8 (likely binary) - nothing to do
        }
      }
    }

    if (!cvText || cvText.trim().length < 80) {
      return res.status(400).json({
        ok: false,
        error: 'Could not extract CV text from DeepSeek, uploaded DOCX, or uploaded file. Ensure DeepSeek share is public or upload a readable DOCX/PDF.'
      });
    }

    const sections = parseCvSections(cvText);
    const html = generateFullHtml(sections, themeType, themeColors, professional);
    return res.json({ ok: true, html });
  } catch (err) {
    console.error('generate error:', err && (err.stack || err.message || err));
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.get('/', (req, res) => res.send('HTML Generator (DeepSeek/DOCX) running'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
