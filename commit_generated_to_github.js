// commit_generated_to_github.js
// Usage:
//  export GITHUB_TOKEN="ghp_xxx"
//  export GITHUB_OWNER="your-username"
//  export GITHUB_REPO="your-repo"
//  export GENERATE_ENDPOINT="https://html-generator-oos8.onrender.com"   # base url (no trailing /generate)
//  node commit_generated_to_github.js

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // v2
const FormData = require('form-data');
const { Octokit } = require('@octokit/rest');
const sanitizeHtml = require('sanitize-html');

const BASE = process.env.GENERATE_ENDPOINT || 'http://localhost:3000';
const UPLOAD_URL = BASE.replace(/\/$/, '') + '/upload-cv';
const GENERATE_URL = BASE.replace(/\/$/, '') + '/generate';

// Local file path (from your session). This file must exist where you run this script.
const LOCAL_FILE_TO_UPLOAD = '/mnt/data/aasss.pdf'; // <-- path taken from conversation history

// GitHub config (from env)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'your-github-username';
const GITHUB_REPO  = process.env.GITHUB_REPO  || 'your-repo';
const GITHUB_PATH  = process.env.GITHUB_PATH  || 'generated/cv-aasss.html';
const COMMIT_MSG   = process.env.COMMIT_MSG   || 'Add generated CV site (aasss)';

if (!GITHUB_TOKEN) {
  console.error('Set GITHUB_TOKEN in env.');
  process.exit(1);
}
if (!fs.existsSync(LOCAL_FILE_TO_UPLOAD)) {
  console.error('Local file not found:', LOCAL_FILE_TO_UPLOAD);
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

async function uploadFileToBackend(localPath) {
  const fd = new FormData();
  fd.append('cv', fs.createReadStream(localPath));

  console.log('Uploading file to backend:', UPLOAD_URL);
  const res = await fetch(UPLOAD_URL, { method: 'POST', body: fd });
  if (!res.ok) {
    throw new Error('Upload failed: ' + res.status + ' ' + (await res.text()));
  }
  const j = await res.json();
  if (!j || !j.ok) throw new Error('Upload endpoint returned error: ' + JSON.stringify(j));
  // prefer localPath returned by server
  return j.localPath || j.url || j.originalname || null;
}

async function generateHtmlOnBackend(uploadedFilePath, themeType='photographer', themeColors='white blue', professional=true) {
  const payload = {
    deepseekUrl: '',
    themeType,
    themeColors,
    professional,
    uploadedFilePath
  };
  console.log('Requesting generation with uploadedFilePath:', uploadedFilePath);
  const res = await fetch(GENERATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    throw new Error('Generate failed: ' + res.status + ' ' + (await res.text()));
  }
  const j = await res.json();
  if (!j || !j.ok || !j.html) throw new Error('Generate response not valid: ' + JSON.stringify(j));
  return j.html;
}

function sanitizeGeneratedHtml(html) {
  const cleaned = sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img','style']),
    allowedAttributes: {
      a: ['href','name','target','rel'],
      img: ['src','alt','width','height'],
      '*': ['class','id','style']
    },
    transformTags: {
      'script': () => ({ tagName: 'noscript', text: '' })
    }
  });
  return cleaned.replace(/\son\w+\s*=\s*(["']).*?\1/gi, ''); // remove inline on* handlers if any remain
}

async function getFileSha(owner, repo, path) {
  try {
    const r = await octokit.repos.getContent({ owner, repo, path });
    return r && r.data && r.data.sha ? r.data.sha : null;
  } catch (e) {
    return null;
  }
}

async function commitToGithub(owner, repo, path, base64Content, message, sha=null) {
  const params = { owner, repo, path, message, content: base64Content, committer: { name: 'HTML Generator', email: 'noreply@example.com' } };
  if (sha) params.sha = sha;
  return octokit.repos.createOrUpdateFileContents(params);
}

(async () => {
  try {
    // 1) Upload local file to backend -> get server-side path
    const uploadedPath = await uploadFileToBackend(LOCAL_FILE_TO_UPLOAD);
    console.log('Backend returned path/url:', uploadedPath);

    // 2) Ask backend to generate HTML using that uploaded path
    const rawHtml = await generateHtmlOnBackend(uploadedPath, 'photographer', 'white blue', true);
    console.log('Generated HTML length:', rawHtml.length);

    // 3) Sanitize
    const safeHtml = sanitizeGeneratedHtml(rawHtml);
    const base64 = Buffer.from(safeHtml, 'utf8').toString('base64');

    // 4) Commit to GitHub (create or update)
    const existingSha = await getFileSha(GITHUB_OWNER, GITHUB_REPO, GITHUB_PATH);
    const resp = await commitToGithub(GITHUB_OWNER, GITHUB_REPO, GITHUB_PATH, base64, COMMIT_MSG, existingSha);
    console.log('Committed:', resp && resp.data && resp.data.content && resp.data.content.html_url);
    console.log('Raw URL (if repo public):', `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/main/${GITHUB_PATH}`);
  } catch (err) {
    console.error('Error:', err && (err.stack || err.message || err));
    process.exit(1);
  }
})();
