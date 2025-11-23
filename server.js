const express = require("express");
const multer = require("multer");
const fetch = require("node-fetch");
const sanitizeHtml = require("sanitize-html");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// Multer for file uploads
const upload = multer({ dest: "uploads/" });

// Endpoint: upload CV
app.post("/upload-cv", upload.single("cv"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  res.json({
    ok: true,
    filename: req.file.filename,
    originalname: req.file.originalname
  });
});

// Endpoint: generate HTML using DeepSeek link + theme
app.post("/generate", async (req, res) => {
  try {
    const { deepseekUrl, themeType, themeColors, professional } = req.body;

    if (!deepseekUrl) {
      return res.status(400).json({ error: "deepseekUrl required" });
    }

    // Fetch HTML from DeepSeek URL
    const response = await fetch(deepseekUrl, {
      headers: {
        "User-Agent": "HTML-Generator/1.0"
      }
    });

    if (!response.ok) {
      return res.status(500).json({
        error: `Failed to fetch ${deepseekUrl}`,
        status: response.status
      });
    }

    let html = await response.text();

    const cleaned = sanitizeHtml(html, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "style"]),
      allowedAttributes: {
        "*": ["class", "id", "src", "href", "alt", "style"]
      },
      allowedSchemes: ["http", "https", "data", "mailto"]
    });

    // Generate themed HTML
    const finalHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Generated HTML</title>
        <style>
          body {
            margin: 20px;
            font-family: ${professional ? "Georgia, serif" : "Arial"};
          }

          /* Dynamic user theme */
          :root {
            --theme-type: "${themeType}";
            --theme-colors: "${themeColors}";
          }

          /* Example styling rules using dynamic theme */
          h1, h2, h3 {
            color: var(--theme-colors);
          }

          .theme-banner {
            padding: 10px;
            background: var(--theme-colors);
            color: white;
            border-radius: 6px;
            margin-bottom: 15px;
          }
        </style>
      </head>
      <body>
        <div class="theme-banner">
          Theme Type: ${themeType} | Colors: ${themeColors} | Professional: ${professional}
        </div>

        ${cleaned}
      </body>
      </html>
    `;

    res.json({ ok: true, html: finalHtml });

  } catch (err) {
    res.status(500).json({
      error: "Server error",
      details: err.message
    });
  }
});

// Run server on Render assigned port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
