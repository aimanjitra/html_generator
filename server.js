// server.js
// DeepSeek-share-link based CV → Full HTML generator (NO OpenAI required)

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

// Default file path (you provided earlier)
const DEFAULT_UPLOADED_FILE_PATH = '/mnt/data/f124d69d-5701-4fec-9da5-ed21e5db7eecd1cc.png';

// Sanitize text
function cleanText(t) {
  if (!t) return '';
  return sanitizeHtml(t, { allowedTags: [], allowedAttributes: {} })
    .replace(/\r/g, '')
    .trim();
}

// Upload CV
app.post('/upload-cv', upload.single('cv'), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ ok: false, error: 'No file uploaded' });

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

// Fetch DeepSeek share page text
async function fetchDeepseekText(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 20000
    });

    if (!res.ok) throw new Error('DeepSeek page not accessible');

    const html = await res.text();
    const $ = cheerio.load(html);

    let collected = '';

    const selectors = ['article', '.chat', '.message', '.prose', '#root', 'main'];

    for (const sel of selectors) {
      const el = $(sel);
      if (el.length) {
        el.each((i, node) => {
          const txt = cleanText($(node).text());
          if (txt.length > 25) collected += txt + '\n\n';
        });
      }
      if (collected.length > 200) break;
    }

    if (collected.length < 100) {
      const bodyTxt = cleanText($('body').text());
      collected = bodyTxt;
    }

    return collected.trim();
  } catch (err) {
    console.error('DeepSeek fetch error:', err);
    return '';
  }
}

// Parse CV into sections
function parseCvSections(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const sections = {
    raw: text,
    name: lines[0] || 'Candidate Name',
    summary: lines.slice(1, 6).join(' ')
  };

  function extract(header) {
    const idx = lines.findIndex(l => l.toLowerCase().includes(header));
    if (idx === -1) return '';
    const nextHeader = lines.findIndex((l, i) =>
      i > idx &&
      ['experience', 'education', 'skills', 'projects', 'achievements']
        .some(h => l.toLowerCase().includes(h))
    );
    return lines.slice(idx + 1, nextHeader === -1 ? lines.length : nextHeader).join('\n');
  }

  sections.experience = extract('experience');
  sections.education = extract('education');
  sections.skills = extract('skills');
  sections.projects = extract('projects');
  sections.achievements = extract('achievement');

  return sections;
}

// Build final website HTML
function generateFullHtml(sections, themeType, themeColors, professional) {
  function esc(s) {
    return sanitizeHtml(s || '', { allowedTags: [], allowedAttributes: {} }).replace(/\n/g, '<br>');
  }

  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(sections.name)} — CV Website</title>
<style>
  body { font-family: Arial; background:#f5f7fa; padding:20px; }
  .wrap { background:white; padding:25px; max-width:900px; margin:auto; border-radius:10px; }
  h1 { margin-bottom:0 }
  h2 { color:#6c5ce7; margin-top:30px; }
  .card { background:#f3f3ff; padding:12px; border-radius:8px; margin-top:8px; }
  .skill { display:inline-block; padding:6px 10px; background:#e9eaff; border-radius:20px; margin:4px; }
</style>
</head>
<body>
<div class="wrap">

  <h1>${esc(sections.name)}</h1>
  <p>${esc(sections.summary)}</p>

  <h2>Experience</h2>
  <div class="card">${esc(sections.experience)}</div>

  <h2>Projects</h2>
  <div class="card">${esc(sections.projects)}</div>

  <h2>Education</h2>
  <div class="card">${esc(sections.education)}</div>

  <h2>Achievements</h2>
  <div class="card">${esc(sections.achievements)}</div>

  <h2>Skills</h2>
  <div class="card">
    ${sections.skills ? sections.skills.split(/[,\\n]+/).map(s => `<span class="skill">${esc(s)}</span>`).join('') : 'No skills found'}
  </div>

  <footer style="margin-top:40px; color:#666;">
    Theme: ${themeType} | Colors: ${themeColors} | Professional: ${professional}
  </footer>

</div>
</body>
</html>
`;
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
    } = req.body;

    console.log('Received from frontend:', req.body);

    let cvText = '';

    // Try DeepSeek link first
    if (deepseekUrl) {
      cvText = await fetchDeepseekText(deepseekUrl);
    }

    if (!cvText || cvText.length < 50)
      return res.json({ ok: false, error: 'DeepSeek link did not return valid text.' });

    const sections = parseCvSections(cvText);
    const html = generateFullHtml(sections, themeType, themeColors, professional);

    return res.json({ ok: true, html });

  } catch (err) {
    console.error(err);
    return res.json({ ok: false, error: err.message });
  }
});

app.get('/', (req, res) => res.send('HTML Generator DeepSeek Edition Running'));
app.listen(process.env.PORT || 3000, () => console.log('Server running'));
