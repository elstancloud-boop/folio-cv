/* Folio server: serves the app and proxies AI requests so the API key never reaches the browser.
   Zero dependencies (Node 18+). Works with any OpenAI-compatible API, including local Ollama.
   Env: LLM_API_KEY, LLM_BASE_URL (default https://api.openai.com/v1), LLM_MODEL (default gpt-4o-mini), PORT */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');

const PORT = +process.env.PORT || 8080;
const BASE = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const KEY = process.env.LLM_API_KEY || '';
const MODELS = (process.env.LLM_MODEL || 'gpt-4o-mini').split(',').map(x => x.trim()).filter(Boolean); // comma list = fallbacks, tried in order
const MODEL = MODELS[0];
const LOCAL = /\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(BASE);
const ENABLED = !!KEY || LOCAL;
const ROOT = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };
const STATIC_OK = new Set(['index.html', 'styles.css', 'app.js', 'ai.js', 'linkedin.js', 'cover.js', 'sw.js', 'manifest.webmanifest']);

/* ---------- prompts ---------- */
const SCHEMA = `Return ONLY a JSON object with this exact shape (use "" or [] when unknown):
{"personal":{"name":"","title":"","email":"","phone":"","location":"","website":"","linkedin":""},
"summary":"",
"experience":[{"role":"","company":"","location":"","start":"YYYY-MM","end":"YYYY-MM","current":false,"bullets":["",""]}],
"education":[{"school":"","degree":"","start":"YYYY-MM","end":"YYYY-MM","details":""}],
"skills":[""],
"projects":[{"name":"","link":"","desc":""}],
"certifications":[{"name":"","issuer":"","year":""}],
"languages":[{"name":"","level":""}],
"tips":["short suggestion for the user"]}`;
const RULES = `Hard rules: never invent employers, job titles, dates, qualifications, skills, or numbers that the user did not provide. If a date is only a year, use YYYY-01 for a start and YYYY-12 for an end. Order jobs newest first. No first-person pronouns in bullets. Plain, confident, concise wording. Dedupe skills. No emojis, no em dashes.`;
const PROMPTS = {
  generate: d => ({
    system: `You are an elite resume writer and career coach turning a beginner's rough answers into a standout, ATS-friendly resume. Even when the answers are thin, make the resume feel complete and strong.
Tone requested: ${({ bold: 'BOLD and confident, punchy verbs, strong claims backed by the facts given', friendly: 'warm, human and approachable, still professional', pro: 'polished, professional and concise' })[d.answers && d.answers.tone] || 'polished, professional and concise'}.
FACTS vs SUGGESTIONS (very important):
- "bullets" per job: ONLY the user's own facts, rewritten powerfully (strong past-tense verb, present tense for current job, outcome first, one line, max 22 words). Use their "win" as the first bullet. Split combined duties into separate bullets. Never invent numbers, employers, dates or qualifications.
- "suggested" per job: 2 to 4 extra bullets describing duties and skills that are TYPICAL for that exact job title in that industry and that the person very likely did, written in the same style, with no invented numbers or named tools unless implied. The user will tick which ones are true.
- "suggestedSkills": 6 to 10 skills and keywords recruiters search for this target job (hard skills first, then 2 soft skills), not already in "skills". 
- "skills": the user's skills, cleaned and capitalised; if they gave none, infer 6 from their job titles and duties.
- "summary": 40 to 60 words, hooks with their strongest identity plus a proven strength, mentions target role, no clichés (hard-working, team player, passionate), no first person.
- "tips": up to 4 specific prompts, for example "Add a number to your 'trained staff' bullet: how many people?".
${RULES}
Return ONLY this JSON (extra keys allowed as shown):
{"personal":{"name":"","title":"","email":"","phone":"","location":"","website":"","linkedin":""},"summary":"",
"experience":[{"role":"","company":"","location":"","start":"YYYY-MM","end":"YYYY-MM","current":false,"bullets":[""],"suggested":[""]}],
"education":[{"school":"","degree":"","start":"YYYY-MM","end":"YYYY-MM","details":""}],
"skills":[""],"suggestedSkills":[""],"projects":[],"certifications":[{"name":"","issuer":"","year":""}],"languages":[{"name":"","level":""}],"tips":[""]}`,
    user: 'The user\'s answers:\n' + JSON.stringify(d.answers, null, 1)
  }),
  parse: d => ({
    system: `You convert the raw text of an existing CV into structured data. ${d.polish ? 'Also polish wording: start bullets with strong action verbs, fix grammar, tighten phrasing, and write a 35 to 55 word summary if none exists, but keep every fact.' : 'Preserve the original wording; only fix obvious typos and split text into bullets.'} Keep every job and qualification found. Put anything that does not fit elsewhere into projects or certifications. In "tips", list up to 4 improvements you would suggest. ${RULES}\n${SCHEMA}`,
    user: 'CV text:\n"""\n' + String(d.text).slice(0, 24000) + '\n"""'
  }),
  improve: d => ({
    system: d.kind === 'line'
      ? `You rewrite ONE resume bullet. Give 3 alternative versions, each one line, max 25 words, starting with a strong action verb, keeping only the facts given. ${d.number ? 'The user supplied this real figure, work it in naturally: ' + String(d.number).slice(0, 60) + '.' : 'Do not add numbers.'} ${RULES}\nReturn ONLY JSON in exactly this shape: {"versions":["<first rewrite>","<second rewrite>","<third rewrite>"]}`
      : d.kind === 'summary'
      ? `You rewrite resume summaries. Output 35 to 55 words, 2 to 3 sentences, no first-person pronouns, using only facts present in the input. ${RULES}\nReturn ONLY JSON: {"text":"..."}`
      : `You rewrite resume bullet points for one job. Return 2 to 5 bullets, each starting with a strong action verb, one line, max 25 words, keeping only facts provided (do not add numbers). If a bullet lacks a number, keep it numberless. ${RULES}\nReturn ONLY JSON: {"text":"bullet one\\nbullet two"} (bullets separated by newlines).`,
    user: JSON.stringify({ jobTitleTarget: d.title, role: d.role, company: d.company, text: d.text, resumeContext: d.context })
  }),
  linkedin: d => ({
    system: `You are a LinkedIn profile strategist and recruiter-search expert. From the resume, write a LinkedIn profile that is consistent with it but written for LinkedIn: first person, warm, specific, rich in the keywords recruiters search. Avoid empty buzzwords (passionate, guru, ninja, results-driven). Return ONLY JSON:
{"headlines":[{"style":"Keyword-rich","text":"Role | skill | skill | value (max 220 chars)"},{"style":"Value-led","text":"what you help whom achieve (max 220 chars)"},{"style":"Human","text":"short and personal (max 120 chars)"}],
"about":"900 to 1500 characters. The first two lines must hook the reader because only they show before 'see more'. Short paragraphs, 3 to 5 strengths, proof only from the resume, end with a call to action and what you are open to.",
"experience":[{"role":"","company":"","text":"2 to 4 short sentences or lines for LinkedIn, max 600 chars"}],
"skills":{"top":["3 to pin"],"more":["up to 20 more, only skills evidenced by the resume or clearly implied by the roles"]},
"featured":["3 ideas of things to feature on the profile, phrased as suggestions"],
"banner":{"l1":"tagline, max 6 words","l2":"proof or keywords, max 10 words"},
"urls":["3 custom URL suggestions: lowercase letters, digits, hyphens"],
"keywords":["10 recruiter search keywords for the target roles"],
"outreach":{"connect":"connection note, max 280 chars, use [Name] placeholder","recruiter":"message to a recruiter, max 600 chars, use [Name] and [Role]","follow":"polite follow-up after no reply, max 300 chars"},
"tips":["4 specific profile actions for this person"]}
${RULES}`,
    user: 'Goal of the user (may be empty): ' + String(d.goal || '').slice(0, 300) + '\n\nRESUME:\n' + String(d.resume).slice(0, 14000)
  }),
  cover: d => ({
    system: `You write a cover letter from a resume, aimed at one job. Tone: ${({ warm: 'warm, human and genuine', formal: 'formal and polished', bold: 'confident and direct' })[d.tone] || 'confident and direct'}. Length: ${d.length === 'short' ? 'about 170 words' : 'about 220 words'} in 3 or 4 short paragraphs.
Paragraph 1: why this role${d.company ? ' at ' + String(d.company).slice(0, 80) : ''} and one standout strength. Middle paragraphs: the 2 or 3 strongest facts from the resume that match what the job advert asks for, told as short proof, not a list of duties. Last paragraph: simple call to action.
${RULES} Use ONLY facts present in the resume. Do not state years of experience, cost savings, certification counts, tools, or any outcome that is not written in the resume, and do not paraphrase a number into a different one. If the advert asks for something the resume does not show, do not claim it. Hard limit: 230 words. Do not open with "I am writing to apply". No clichés (passionate, team player, hard-working, results-driven). Write in first person.
Return ONLY JSON: {"greeting":"Dear ...,","paragraphs":["","",""],"closing":"Kind regards,"}`,
    user: 'Role applying for: ' + String(d.role || '').slice(0, 120) + '\nCompany: ' + String(d.company || '').slice(0, 120) + '\nHiring manager (may be empty): ' + String(d.manager || '').slice(0, 80) + '\n\nRESUME:\n' + String(d.resume).slice(0, 12000) + '\n\nJOB ADVERT (may be empty):\n' + String(d.job || '').slice(0, 8000)
  }),
  tailor: d => ({
    system: `You compare a resume with a job description. Return ONLY JSON: {"matchScore":0-100,"present":["keywords from the job the resume already shows"],"missing":["important keywords or skills the job wants that the resume lacks (max 10)"],"summary":"a rewritten 35 to 55 word summary aimed at this job using only true facts from the resume","advice":["max 4 short specific actions"]}. ${RULES}`,
    user: 'RESUME:\n' + String(d.resume).slice(0, 12000) + '\n\nJOB DESCRIPTION:\n' + String(d.job).slice(0, 8000)
  })
};

/* ---------- LLM call ---------- */
async function llm(p) {
  let err;
  for (const m of MODELS) {
    try { return await llmOne(p, m, true); }
    catch (e) { err = e; if (/LLM (401|403)/.test(e.message)) break; console.warn('model ' + m + ' failed, trying next:', e.message.slice(0, 120)); }
  }
  throw err;
}
async function llmOne({ system, user }, model, json) {
  const body = { model, temperature: 0.3, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (json) body.response_format = { type: 'json_object' };
  const r = await fetch(BASE + '/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(+process.env.LLM_TIMEOUT_MS || 90000),
    headers: { 'Content-Type': 'application/json', ...(KEY ? { Authorization: 'Bearer ' + KEY } : {}) },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    if (json && r.status === 400) return llmOne({ system, user }, model, false); // provider without JSON mode
    throw new Error('LLM ' + r.status + ' ' + (await r.text()).slice(0, 200));
  }
  const j = await r.json();
  return parseJson(j.choices?.[0]?.message?.content || '');
}
function parseJson(t) {
  t = t.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch (e) {
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('Model did not return JSON');
  }
}

/* ---------- http ---------- */
const hits = new Map();
function limited(ip) {
  const now = Date.now(), h = hits.get(ip) || { n: 0, t: now + 600000 };
  if (now > h.t) { h.n = 0; h.t = now + 600000; }
  h.n++; hits.set(ip, h);
  if (hits.size > 5000) for (const [k, v] of hits) if (now > v.t) hits.delete(k);
  return h.n > (+process.env.RATE_LIMIT || 30);
}
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
function readBody(req) {
  return new Promise((ok, no) => {
    let s = 0; const c = [];
    req.on('data', d => { s += d.length; if (s > 100000) { no(new Error('too large')); req.destroy(); } else c.push(d); });
    req.on('end', () => ok(Buffer.concat(c).toString()));
    req.on('error', no);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (u.pathname === '/api/health') return send(res, 200, { ok: true, ai: ENABLED });
  if (u.pathname === '/api/ai' && req.method === 'POST') {
    if (!ENABLED) return send(res, 503, { error: 'AI is not configured on this server.' });
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    if (limited(ip)) return send(res, 429, { error: 'Too many AI requests. Try again in a few minutes.' });
    try {
      const d = JSON.parse(await readBody(req));
      if (!PROMPTS[d.task]) return send(res, 400, { error: 'Unknown task' });
      const out = await llm(PROMPTS[d.task](d.payload || {}));
      return send(res, 200, { result: out });
    } catch (e) {
      console.error('AI error:', e.message);
      return send(res, 502, { error: 'The AI service had a problem. Please try again.' });
    }
  }
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  let f = u.pathname === '/' ? 'index.html' : (/^\/fonts\/[\w-]+\.woff2$/.test(u.pathname) ? u.pathname.slice(1) : path.basename(u.pathname));
  if (!STATIC_OK.has(f) && !f.startsWith('fonts/')) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(ROOT, f), (e, data) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain', 'Cache-Control': f === 'index.html' ? 'no-cache' : 'public, max-age=300' });
    res.end(data);
  });
});
server.listen(PORT, () => console.log(`Folio running on http://localhost:${PORT}  (AI ${ENABLED ? 'on → ' + MODELS.join(' | ') : 'off: set LLM_API_KEY'})`));
