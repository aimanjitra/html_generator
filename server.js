// server.js
// DeepSeek-share-link based CV → Full HTML generator (cleaner extraction + theme handling)

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const sanitizeHtml = require('sanitize-html');

const app = express();
app.use(cors());
app.use(express.json());

// Upload folder
const upload = multer({ dest: 'uploads/' });

// DEFAULT uploaded file path you provided earlier (keep it if you're using that local file)
const DEFAULT_UPLOADED_FILE_PATH = '/mnt/data/f124d69d-5701-4fec-9c21-e5db7eecd1cc.png';

// sanitize text helper
function cleanText(t) {
  if (!t) return '';
  return sanitizeHtml(t, { allowedTags: [], allowedAttributes: {} })
    .replace(/\r/g, '')
    .trim();
}

// Upload CV: returns localPath
app.post('/upload-cv', upload.single('cv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    const localPath = path.resolve(req.file.path);
    return res.json({
      ok: true,
      filename: req.file.filename,
      originalname: req.file.originalname,
      localPath
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/*
  Fetch DeepSeek share page and extract meaningful text.
  Improved strategy:
   - Remove <script>, <noscript>, <style>, and inline event handlers
   - Pull from common selectors
   - Filter out code-like lines (cdn-cgi, function(...), document., long one-line base64/js blobs)
*/
async function fetchDeepseekText(url) {
  try {
    const res = await fetch(url, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 });
    if (!res.ok) throw new Error(`Fetch failed with status ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    // remove script/style/noscript elements entirely
    $('script, style, noscript, iframe').remove();

    // remove attributes that might contain JS
    $('*').each((i, el) => {
      const attribs = el.attribs || {};
      for (const a of Object.keys(attribs)) {
        if (/on\w+/i.test(a)) $(el).removeAttr(a);
      }
    });

    // try several selectors that could contain chat text
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

    // fallback: extract full body text and then filter noise
    if (!collected || collected.length < 200) {
      let bodyText = cleanText($('body').text() || '');
      // split into lines then filter out script/noise lines
      let lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);

      // remove lines that appear script-like or tiny
      const noisePatterns = [
        /^<\s*script/i,
        /cdn-cgi/i,
        /window\.__CF|__CF\$cv|__cf/i,
        /function\s*\(/i,
        /document\./i,
        /^[\{\};=\/\(\)]+$/,
        /^[\w+=\/]{60,}$/ // very long base64 or blob-like lines
      ];
      lines = lines.filter(line => {
        for (const pat of noisePatterns) if (pat.test(line)) return false;
        // remove lines that are just UI labels
        if (/^(Share|Copied|Sign in|Sign up|Home|About|OpenAI|DeepSeek)$/i.test(line)) return false;
        return line.length > 2;
      });

      collected = lines.join('\n\n');
    }

    // final pass: remove sequences of many non-letter characters and long single-line JS remnants
    collected = collected.split('\n').filter(l => {
      // drop lines that are probably leftover JS
      if (/^[\s\W]{10,}$/.test(l)) return false;
      if (/function\s*\(|document\.|cdn-cgi|__CF\$|eval\(|<script/i.test(l)) return false;
      // drop extremely long single-line tokens without spaces (typical base64 or JS blobs)
      if (l.length > 200 && !/\s/.test(l)) return false;
      return true;
    }).join('\n').replace(/\n{3,}/g, '\n\n').trim();

    return collected;
  } catch (err) {
    console.error('fetchDeepseekText error:', err);
    return '';
  }
}

// parse text heuristically into sections
function parseCvSections(text) {
  const trimmed = (text || '').replace(/\r/g, '').trim();
  const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);

  // find first meaningful line as name
  let name = 'Candidate Name';
  for (let i = 0; i < Math.min(6, lines.length); i++) {
    const l = lines[i];
    // skip lines that look like code or noise
    if (/function\s*\(|document\.|cdn-cgi|__CF\$|https?:\/\//i.test(l)) continue;
    if (l.length > 3 && l.split(' ').length <= 8) { name = l; break; }
  }

  // summary: take lines after name (up to 6)
  const nameIndex = lines.findIndex(l => l === name);
  const summary = lines.slice(nameIndex + 1, nameIndex + 6).join(' ') || '';

  // naive section extractor based on headings keywords
  const lower = lines.map(l => l.toLowerCase());
  function extract(headerKeys) {
    const idx = lower.findIndex(l => headerKeys.some(h => l.startsWith(h) || l.includes(h)));
    if (idx === -1) return '';
    // find next header
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
    experience: extract(['experience','work experience','employment']),
    education: extract(['education','academic','degree']),
    skills: extract(['skills','technical skills','skill']),
    projects: extract(['projects','project']),
    achievements: extract(['achievements','awards','honours']),
    contact: extract(['contact','email','phone','linkedin'])
  };

  // if no headings found, fallback: assign some chunk into experience
  if (!sections.experience && lines.length > 6) {
    sections.experience = lines.slice(6, Math.min(lines.length, 40)).join('\n');
  }

  return sections;
}

// produce final HTML using the theme params
function generateFullHtml(sections, themeType='modern', themeColors='black', professional=true) {
  function esc(s) {
    return sanitizeHtml(String(s || ''), { allowedTags: [], allowedAttributes: {} }).replace(/\n/g, '<br>');
  }
  const primary = (themeColors || '').split(/\s+/)[0] || '#111111';
  const accent = '#6c5ce7';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(sections.name)} — CV Website</title>
<style>
  :root{--primary:${primary};--accent:${accent};--bg:#fff;--text:#222}
  body{font-family:Inter,system-ui,Segoe UI,Arial;padding:24px;background:#f6f8fb;color:var(--text)}
  .wrap{max-width:980px;margin:auto;background:var(--bg);padding:28px;border-radius:12px;box-shadow:0 10px 30px rgba(20,20,40,.06)}
  header{display:flex;gap:18px;align-items:center;border-bottom:1px solid #eee;padding-bottom:18px;margin-bottom:18px}
  .avatar{width:90px;height:90px;border-radius:14px;background:linear-gradient(135deg,var(--accent),var(--primary));display:flex;align-items:center;justify-content:center;color:white;font-weight:700;font-size:28px}
  h1{margin:0;font-size:24px}
  .meta{color:#666;margin-top:6px}
  .section{margin-bottom:18px}
  .section h2{color:var(--primary);margin:0 0 8px 0}
  .card{background:#fbfbff;padding:12px;border-radius:10px;border:1px solid #f0f0ff}
  .skill{display:inline-block;padding:6px 10px;margin:4px;border-radius:999px;background:#f2f3ff;font-size:13px}
  footer{margin-top:28px;color:#666;font-size:13px}
  pre{white-space:pre-wrap;font-family:inherit}
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
      <div class="card"><pre>${esc(sections.experience || 'No experience found.')}</pre></div>
    </div>

    <div class="section">
      <h2>Projects</h2>
      <div class="card"><pre>${esc(sections.projects || 'No projects listed.')}</pre></div>
    </div>

    <div class="section">
      <h2>Education</h2>
      <div class="card"><pre>${esc(sections.education || 'No education found.')}</pre></div>
    </div>

    <div class="section">
      <h2>Achievements</h2>
      <div class="card"><pre>${esc(sections.achievements || '')}</pre></div>
    </div>

    <div class="section">
      <h2>Skills</h2>
      <div class="card">
        ${sections.skills ? sections.skills.split(/[,\\n]+/).map(s=>`<span class="skill">${esc(s)}</span>`).join('') : 'No skills found'}
      </div>
    </div>

    <footer>Theme: ${sanitizeHtml(String(themeType))} | Colors: ${sanitizeHtml(String(themeColors))} | Professional: ${professional}</footer>
  </div>
</body>
</html>`;
}

// Generate endpoint
app.post('/generate', async (req, res) => {
  try {
    const {
      deepseekUrl = '',
      themeType = 'modern',
      themeColors = 'black',
      professional = true,
      uploadedFilePath = DEFAULT_UPLOADED_FILE_PATH
    } = req.body || {};

    console.log('Received from frontend:', { deepseekUrl, themeType, themeColors, professional, uploadedFilePath });

    let cvText = '';

    // If a DeepSeek link provided - try fetch & parse
    if (deepseekUrl) {
      cvText = await fetchDeepseekText(deepseekUrl);
    }

    // fallback: if uploaded file is a PDF and present we could try pdf-parse, but pdf-parse may not be installed => skip here.
    // If cvText still empty, try reading uploadedFilePath as text
    if ((!cvText || cvText.length < 50) && uploadedFilePath && fs.existsSync(uploadedFilePath)) {
      try {
        const maybe = fs.readFileSync(uploadedFilePath, 'utf8');
        if (maybe && maybe.length > 50) cvText = maybe;
      } catch (e) {
        // ignore binary files
      }
    }

    if (!cvText || cvText.trim().length < 50) {
      return res.status(400).json({ ok: false, error: 'Could not extract meaningful text from DeepSeek link or uploaded file. Make sure the DeepSeek share is public and contains the chat content.' });
    }

    const sections = parseCvSections(cvText);
    const html = generateFullHtml(sections, themeType, themeColors, professional);

    return res.json({ ok: true, html });
  } catch (err) {
    console.error('generate error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/', (req, res) => res.send('HTML Generator DeepSeek Edition Running'));
app.listen(process.env.PORT || 3000, () => console.log('Server running'));
