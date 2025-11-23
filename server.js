// server.js
// Uses DeepSeek share URL as source; parses content and generates a full HTML website locally.
// No OpenAI call required.

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const fetch = require('node-fetch'); // v2 style
const cheerio = require('cheerio');
const sanitizeHtml = require('sanitize-html');

const app = express();
app.use(cors());
app.use(express.json());

// Multer setup - saves to uploads/ directory
const upload = multer({ dest: 'uploads/' });

// Default uploaded file (developer-provided path)
const DEFAULT_UPLOADED_FILE_PATH = '/mnt/data/f124d69d-5701-4fec-9c21-e5db7eecd1cc.png';

// Utility: sanitize text for safety
function cleanText(t) {
  if (!t) return '';
  return sanitizeHtml(t, { allowedTags: [], allowedAttributes: {} }).replace(/\r/g, '');
}

// Upload endpoint (unchanged)
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
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Fetch DeepSeek share page and extract text.
// If the page uses dynamic JS to render content this still often contains the chat content in the HTML snapshot for share pages.
async function fetchDeepseekText(url) {
  try {
    const res = await fetch(url, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 });
    if (!res.ok) {
      throw new Error(`Fetch failed with status ${res.status}`);
    }
    const html = await res.text();
    const $ = cheerio.load(html);

    // Heuristic extraction:
    // Try common selectors that might hold chat content; otherwise fallback to main body text.
    // We will collect text nodes that look meaningful (non-empty and not navigation).
    const selectors = [
      'article',          // sometimes chat content is in article
      '.chat',            // general
      '.message',         // common name
      '.chat-message',
      '.prose',
      '#root',
      'main'
    ];

    let collected = '';
    for (const sel of selectors) {
      const el = $(sel);
      if (el && el.length) {
        // gather text from found elements but filter out tiny bits
        el.each((i, node) => {
          const txt = cleanText($(node).text()).trim();
          if (txt.length > 20) collected += txt + '\n\n';
        });
        if (collected.trim().length > 200) break;
      }
    }

    // fallback: get big body text but filter out common UI strings
    if (!collected || collected.trim().length < 100) {
      const bodyText = cleanText($('body').text()).replace(/\s{2,}/g, '\n').trim();
      // remove obvious navigation words that pollute result
      const noise = ['Share', 'Copied', 'OpenAI', 'Sign in', 'Sign up', 'DeepSeek', 'Home', 'About'];
      let filtered = bodyText.split('\n').filter(line => {
        const s = line.trim();
        if (s.length < 4) return false;
        for (const n of noise) if (s.includes(n)) return false;
        return true;
      }).join('\n');
      collected = filtered;
    }

    // final cleanup
    collected = collected.replace(/\n{3,}/g, '\n\n').trim();
    return collected;
  } catch (err) {
    console.error('fetchDeepseekText error:', err);
    return '';
  }
}

// Simple rule-based extraction to split into CV sections from a chunk of text.
// This is heuristic: looks for common headings (Experience, Education, Skills, Projects, Contact)
function parseCvSections(text) {
  const lower = text.replace(/\r/g, '');
  const lines = lower.split('\n').map(l => l.trim()).filter(l => l);
  const joined = lines.join('\n');

  // find known headings positions
  const headings = ['experience', 'education', 'skills', 'projects', 'contact', 'summary', 'achievements', 'certifications'];
  const sections = {};
  // naive approach: find positions of headings and slice ranges
  const linesLower = lines.map(l => l.toLowerCase());
  let idxMap = [];
  for (let i = 0; i < linesLower.length; i++) {
    if (headings.includes(linesLower[i])) idxMap.push({ name: linesLower[i], i });
  }

  // if no headings found, attempt to detect by keywords
  if (idxMap.length === 0) {
    // try to detect "experience" word inside lines
    lines.forEach((ln, i) => {
      const ll = ln.toLowerCase();
      headings.forEach(h => {
        if (ll.includes(h) && !idxMap.find(x => x.name===h)) idxMap.push({ name: h, i });
      });
    });
  }

  // if still empty, create a simple split: first line = name/title, next 3 lines = summary, rest = experience
  if (idxMap.length === 0) {
    sections.name = lines[0] || '';
    sections.summary = lines.slice(1, 6).join(' ');
    sections.experience = lines.slice(6).join('\n');
    return sections;
  }

  // build sections from idxMap
  idxMap.sort((a,b) => a.i - b.i);
  for (let s = 0; s < idxMap.length; s++) {
    const start = idxMap[s].i + 1; // content after heading
    const end = (s + 1 < idxMap.length) ? idxMap[s+1].i : lines.length;
    const key = idxMap[s].name;
    sections[key] = lines.slice(start, end).join('\n');
  }

  // set name and summary heuristically
  sections.name = lines[0] || '';
  if (!sections.summary && lines.length > 1) {
    sections.summary = lines.slice(1, Math.min(6, lines.length)).join(' ');
  }
  return sections;
}

// Template: produce a full HTML page from parsed sections and theme preferences
function generateFullHtml(sections, themeType='modern', themeColors='black', professional=true) {
  // Minimal color parsing: take first token as primary color; fallback to #111
  const colorToken = (themeColors || '').split(/\s+/)[0] || '';
  const primaryColor = (colorToken && /^#/.test(colorToken)) ? colorToken : (colorToken || '#0a0a0a');
  const accent = '#6c5ce7';

  // Build a safe escaped HTML content from sections
  function esc(s) { return sanitizeHtml(String(s||''), { allowedTags: [], allowedAttributes: {} }).replace(/\n/g, '<br>'); }

  const name = esc(sections.name || 'Candidate Name');
  const summary = esc(sections.summary || '');
  const experience = esc(sections.experience || '');
  const education = esc(sections.education || '');
  const skills = esc(sections.skills || '');
  const projects = esc(sections.projects || '');
  const achievements = esc(sections.achievements || '');

  // full HTML
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${name} — CV Website</title>
<style>
  :root{
    --primary: ${primaryColor};
    --accent: ${accent};
    --bg: #ffffff;
    --text: #222222;
  }
  body{font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial; background: #f6f8fb; color:var(--text); margin:0; padding:28px}
  .wrap{max-width:980px;margin:auto;background:var(--bg);border-radius:12px;padding:28px;box-shadow:0 10px 30px rgba(20,20,40,.06)}
  header{display:flex;align-items:center;gap:18px;border-bottom:1px solid #eee;padding-bottom:18px;margin-bottom:20px}
  .avatar{width:96px;height:96px;border-radius:14px;background:linear-gradient(135deg,var(--accent),var(--primary));display:flex;align-items:center;justify-content:center;color:white;font-weight:700;font-size:28px}
  h1{margin:0;font-size:28px}
  .meta{color:#666;margin-top:6px}
  .section{margin-bottom:20px}
  .section h2{margin:0 0 8px 0;color:var(--primary);font-size:18px}
  .two-col{display:flex;gap:24px}
  .left{flex:3}
  .right{flex:1;min-width:220px}
  .skill-chip{display:inline-block;padding:6px 10px;margin:6px 6px 0 0;border-radius:999px;background:#f2f3ff;color:#222;font-size:13px}
  .card{background:#fbfbff;padding:12px;border-radius:10px;border:1px solid #f0f0ff}
  footer{border-top:1px solid #eee;padding-top:12px;color:#777;font-size:14px;margin-top:30px}
  /* subtle animation */
  .pulse{animation:pulse 2.2s infinite}
  @keyframes pulse{0%{transform:translateY(0)}50%{transform:translateY(-2px)}100%{transform:translateY(0)}}
  pre{white-space:pre-wrap;font-family:inherit}
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="avatar pulse">${(name && name[0]) || 'A'}</div>
      <div>
        <h1>${name}</h1>
        <div class="meta">${summary}</div>
      </div>
    </header>

    <div class="two-col">
      <div class="left">
        <div class="section">
          <h2>Experience</h2>
          <div class="card"><pre>${experience || 'No experience section found.'}</pre></div>
        </div>

        <div class="section">
          <h2>Projects</h2>
          <div class="card"><pre>${projects || 'No projects listed.'}</pre></div>
        </div>

        <div class="section">
          <h2>Education</h2>
          <div class="card"><pre>${education || 'No education section found.'}</pre></div>
        </div>

        <div class="section">
          <h2>Achievements</h2>
          <div class="card"><pre>${achievements || 'No achievements listed.'}</pre></div>
        </div>
      </div>

      <aside class="right">
        <div class="section">
          <h2>Skills</h2>
          <div class="card">${skills ? skills.split(/[,\n]+/).map(s=>`<span class="skill-chip">${s.trim()}</span>`).join('') : '<div>No skills found.</div>'}</div>
        </div>

        <div class="section">
          <h2>Contact</h2>
          <div class="card"><pre>${sections.contact || 'No contact info found.'}</pre></div>
        </div>
      </aside>
    </div>

    <footer>Generated by HTML-Generator · Theme: ${themeType} · Colors: ${themeColors} · Professional: ${professional}</footer>
  </div>
</body>
</html>`;

  return html;
}

// Main generate endpoint using DeepSeek source
app.post('/generate', async (req, res) => {
  try {
    const {
      deepseekUrl = '',
      themeType = 'modern',
      themeColors = 'black',
      professional = true,
      uploadedFilePath = DEFAULT_UPLOADED_FILE_PATH
    } = req.body || {};

    // 1) Prefer extracting text from uploaded file (if it's a pdf)
    let cvText = '';
    try {
      if (uploadedFilePath && fs.existsSync(uploadedFilePath) && path.extname(uploadedFilePath).toLowerCase() === '.pdf') {
        // attempt pdf-parse if available
        try {
          const pdfParse = require('pdf-parse');
          const buffer = fs.readFileSync(uploadedFilePath);
          const pdfData = await pdfParse(buffer);
          if (pdfData && pdfData.text) cvText = pdfData.text;
        } catch (e) {
          // pdf-parse not available or failed; ignore and fallback to deepseek
          console.warn('pdf-parse unavailable or failed; will fallback to deepseek link', e.message || e);
        }
      }
    } catch (e) {
      console.warn('error checking uploadedFilePath', e.message || e);
    }

    // 2) If cvText empty, and deepseekUrl provided, fetch and parse DeepSeek share page
    if ((!cvText || cvText.trim().length < 50) && deepseekUrl) {
      const dsText = await fetchDeepseekText(deepseekUrl);
      if (dsText && dsText.trim().length > 10) cvText = dsText;
    }

    // 3) If still empty, try default local path as last resort
    if ((!cvText || cvText.trim().length < 10) && uploadedFilePath && fs.existsSync(uploadedFilePath)) {
      // attempt to read as text file
      try {
        const raw = fs.readFileSync(uploadedFilePath, 'utf8');
        cvText = raw;
      } catch (e) {
        // binary or unreadable
      }
    }

    if (!cvText || cvText.trim().length < 30) {
      // fallback: return an error instructing the user
      return res.status(400).json({ ok: false, error: 'Could not extract CV text from provided DeepSeek link or uploaded file. Please ensure the DeepSeek link is public share and contains the CV text.' });
    }

    // 4) Parse sections heuristically and generate full HTML template
    const sections = parseCvSections(cvText);
    // include original raw as a fallback
    sections.raw = cvText;

    const html = generateFullHtml(sections, themeType, themeColors, professional);

    return res.json({ ok: true, html });
  } catch (err) {
    console.error('generate error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/', (req, res) => res.send('HTML Generator (DeepSeek mode) running'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
