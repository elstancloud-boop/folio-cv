# Folio – resume builder (v2: mobile + AI)

## Run
- **Basic (no AI):** open `index.html` or `folio-standalone.html`. Everything works with built-in helpers.
- **With AI:** `LLM_API_KEY=sk-... node server.js` then open http://localhost:8080  (Node 18+, no npm install).

## AI providers (any OpenAI-compatible API)
| Provider | LLM_BASE_URL | LLM_MODEL example |
|---|---|---|
| OpenAI (default) | https://api.openai.com/v1 | gpt-4o-mini |
| Groq | https://api.groq.com/openai/v1 | llama-3.3-70b-versatile |
| Local Ollama (free, private) | http://localhost:11434/v1 | qwen2.5:7b |
Ollama needs no key. Set `LLM_BASE_URL` and `LLM_MODEL` only.

## Deploy
Push this folder to GitHub, create a Render "Web Service" (render.yaml included), add `LLM_API_KEY` as a secret. The key stays on the server; the browser only calls /api/ai (rate-limited, 30 requests / 10 min / IP, override with RATE_LIMIT).

## Features
- Wizard + live A4 preview, 4 templates, accent/font/size, section reorder, photo, ATS-style score.
- "Answer a few questions" mode: 7 plain questions → full CV (AI, or rule-based fallback).
- Import old CV: PDF (needs internet for pdf.js), DOCX, TXT or paste → structured CV.
- ✨ buttons: rewrite summary, improve bullets, tailor to a job advert (keyword gap + tailored summary).
- 💼 LinkedIn Studio: headline options (with live profile preview card), About with hook preview, per-job text, skills to pin/add, recruiter keywords, generated banner PNG in your CV colour, custom-URL ideas, tickable profile-setup checklist with strength meter, and outreach/recruiter/follow-up messages. AI task `linkedin`; offline fallback included.
- Mobile: bottom tab bar (Edit / Preview / AI / PDF), bottom-sheet dialogs, tap-to-zoom preview.
- AI never invents facts (prompted), and every suggestion is shown side by side for approval.

## Files
index.html, styles.css, app.js (editor), ai.js (AI + import), linkedin.js (LinkedIn Studio), server.js (static + AI proxy), sw.js (offline cache), build.py (single-file bundle).

## Quick start with Ollama (free, runs on your computer)
1. Install Ollama (https://ollama.com) and Node 18+.
2. Windows: double-click `start-with-ollama.bat`. Mac/Linux: run `./start-with-ollama.sh`.
3. Open http://localhost:8080. The AI buttons turn on automatically.
Tested with qwen2.5:1.5b: all five tasks return valid JSON; the client has safety nets for small-model slips (first-person bullets, invented dates or years, dropped jobs, skills listed as bullets). Use a 3B+ model for better writing. Slow machine? Raise `LLM_TIMEOUT_MS`.
