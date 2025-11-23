// server.js
// Backend using Express that uploads CV, extracts PDF text (if PDF), and calls OpenAI Chat API
// NOTE: set OPENAI_API_KEY in your Render environment variables

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const fetch = require('node-fetch'); // v2 style
const pdfParse = require('pdf-parse'); // npm i pdf-parse

const app = express();
app.use(cors());
app.use(express.json());

// Multer setup - saves to uploads/ directory
const upload = multer({ dest: 'uploads/' });

// Default uploaded file (you said this path earlier)
const DEFAULT_UPLOADED_FILE_PATH = '/mnt/data/f124d69d-5701-4fec-9c21-e5db7eecd1cc.png';

// Helper: extract text if PDF
async function extractTextIfPdf(localPath) {
  if (!localPath || !fs.existsSync(localPath)) return '';
  const ext = path.extname(localPath).toLowerCase();
  try {
    const buffer = fs.readFileSync(localPath);
    if (ext === '.pdf') {
      const data = await pdfParse(buffer);
      return (data && data.text) ? data.text : '';
    }
    // For images or other binary files - we don't OCR here; return empty so prompt uses deepseekUrl
    return '';
  } catch (err) {
    console.error('extractTextIfPdf error:', err);
    return '';
  }
}

// Upload CV endpoint - returns info about uploaded file
app.post('/upload-cv', upload.single('cv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });

    // Optionally you can move the file to a public location or serve it from your server.
    // For now return the local path so you can use it in /generate payload.
    const localPath = path.resolve(req.file.path); // e.g., uploads/abcd
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

// Generate endpoint: uses OpenAI Chat API to request full HTML
app.post('/generate', async (req, res) => {
  try {
    const {
      deepseekUrl = '',
      themeType = 'modern',
      themeColors = 'black',
      professional = true,
      // uploadedFilePath can be provided by frontend (from upload response) or use default local path:
      uploadedFilePath = DEFAULT_UPLOADED_FILE_PATH
    } = req.body || {};

    // Extract CV text (if PDF) from local path - this makes model grounded to real CV content
    let cvText = '';
    if (uploadedFilePath) {
      cvText = await extractTextIfPdf(uploadedFilePath);
    }

    // If cvText is empty, include deepseekUrl as source for the model to consult (if accessible)
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) return res.status(500).json({ ok: false, error: 'OPENAI_API_KEY not set' });

    // Build explicit, strict instruction to produce full long HTML
    const systemPrompt = `
You are a professional web designer and HTML engineer. The user requires a COMPLETE, production-ready, standalone static HTML website created from the candidate's CV.
Important rules:
1) Return ONLY ONE single message containing the COMPLETE HTML source code. Start with <!DOCTYPE html> and include <html>, <head>, and <body>.
2) Inline critical CSS inside a <style> tag in the <head> so the file can be copied and used immediately.
3) Include subtle animations, accessible layout, sections: Header (name + contact), Summary, Experience, Education, Skills, Projects, and Achievement.
4) Use the provided CV to fill those website.
5) Use theme="${themeType}" and colors="${themeColors}". If professional=${professional}, prefer clean typography and spacing.
6) Keep asset references inline as much as practical. Do not include commentary or any extra JSON—only output the HTML.
    `.trim();

    // Compose user message with CV contents and optional deepseekUrl
    const userMessageParts = [];
    if (cvText && cvText.trim().length > 50) {
      userMessageParts.push(`CV_TEXT_START\n${cvText}\nCV_TEXT_END`);
    } else {
      userMessageParts.push(`CV text could not be extracted from local file. Use the deepseek link below as reference if accessible:\n${deepseekUrl}`);
    }
    userMessageParts.push(`Instruction: Create a full, standalone HTML website from the CV above. Use theme: ${themeType}. Colors: ${themeColors}. Professional: ${professional}. Output only the complete HTML markup.`);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessageParts.join('\n\n') }
    ];

    // Call OpenAI Chat Completions (Chat API)
    const payload = {
      model: 'gpt-4o',         // choose a model available to your OpenAI account; replace if needed
      messages,
      max_tokens: 6000,
      temperature: 0.2
    };

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('OpenAI error', text);
      return res.status(500).json({ ok: false, error: 'OpenAI API error', details: text });
    }

    const json = await response.json();
    // Extract assistant content (structure may vary; handle choices[0].message.content)
    const assistantContent = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || json.choices && json.choices[0] && json.choices[0].text || null;

    if (!assistantContent) {
      return res.status(500).json({ ok: false, error: 'No content returned from model', raw: json });
    }

    // Return the HTML to frontend
    return res.json({ ok: true, html: assistantContent });
  } catch (err) {
    console.error('Generate endpoint error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Simple index to check server online
app.get('/', (req, res) => res.send('HTML Generator backend is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
