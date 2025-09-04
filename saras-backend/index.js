// saras-backend/index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import { google } from 'googleapis';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- CORS ----------
const allowOrigin = process.env.ALLOW_ORIGIN || '*';
app.use(
  cors({
    origin:
      allowOrigin === '*'
        ? true
        : (origin, cb) => cb(null, origin === allowOrigin),
  })
);

// ---------- Static hosting of the landing site ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const landingDir = path.resolve(__dirname, '../landing');
app.use(express.static(landingDir));
app.get('/', (_req, res) => res.sendFile(path.join(landingDir, 'landing.html')));

// ---------- OpenAI ----------
if (!process.env.OPENAI_API_KEY) console.warn('WARN: OPENAI_API_KEY is missing in .env');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Google Sheets ----------
const SHEET_ID = process.env.SHEETS_SPREADSHEET_ID;
const KEYFILE  = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const hasSheets = !!SHEET_ID && !!KEYFILE && fs.existsSync(KEYFILE);
let sheets = null;

if (hasSheets) {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEYFILE, // e.g. ./creds/sa.json
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheets = google.sheets({ version: 'v4', auth });
} else {
  console.warn('WARN: Sheets disabled (add SHEETS_SPREADSHEET_ID & GOOGLE_APPLICATION_CREDENTIALS and ensure file exists).');
}

// ---------- Helpers ----------
const trimQuotes = (s) => {
  let t = String(s ?? '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
  return t;
};
const tabRefFromName = (name) => {
  const raw = trimQuotes(name);
  const safe = raw.replace(/'/g, "''");
  return /[\s!]/.test(safe) ? `'${safe}'` : safe;
};
async function appendRow({ tab, values }) {
  if (!sheets) return;
  const range = `${tabRefFromName(tab)}!A:Z`;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });
}

// presales: timestamp | phone | field | value | extra
async function appendPresales({ phone = '', field = '', value = '', extra = '' }) {
  const ts = new Date().toISOString();
  const tab = trimQuotes(process.env.SHEETS_TAB || 'presales');
  await appendRow({ tab, values: [ts, phone, field, value, extra] });
}

// chat_log: timestamp | convId | role | message | phone | latencyMs | page | userAgent | lang
async function appendChatLog({ convId, role, message, phone = '', latencyMs = '', page = '', userAgent = '', lang = '' }) {
  const ts = new Date().toISOString();
  const tab = trimQuotes(process.env.SHEETS_CHAT_TAB || 'chat_log');
  await appendRow({ tab, values: [ts, convId || '', role || '', message || '', phone, latencyMs, page, userAgent, lang] });
}

/** ===== LEADS: WRITE ALWAYS TO ONE FIXED ROW =====
 * Header order (12 cols): timestamp | convId | parent_name | phone | student_name | grade | subjects | mode | area | schedule | budget | demo_consent
 * Writes to row 2 (first data row) by default; set LEADS_FIXED_ROW if you want another.
 */
const LEADS_ROW_INDEX = parseInt(process.env.LEADS_FIXED_ROW || '2', 10);
const LEADS_HEADER_COUNT = 12;

function composeLeadRow({ convId, answers = {} }) {
  const ts = new Date().toISOString();
  return [
    ts,
    convId || '',
    answers.parent_name || '',
    (answers.phone || '').toString(),
    answers.student_name || '',
    answers.grade || '',
    answers.subjects || '',
    answers.mode || '',
    answers.area || '',
    answers.schedule || '',
    answers.budget || '',
    answers.demo_consent || '',
  ];
}
async function updateLeadFixedRow({ convId, answers }) {
  if (!sheets) return;
  const tabName = trimQuotes(process.env.SHEETS_LEADS_TAB || 'leads');
  const tabRef  = tabRefFromName(tabName);
  const range   = `${tabRef}!A${LEADS_ROW_INDEX}:L${LEADS_ROW_INDEX}`;
  const row     = composeLeadRow({ convId, answers }).slice(0, LEADS_HEADER_COUNT);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

// ---------- Conversation state ----------
const SESSIONS = new Map(); // convId -> { answers: Record<string,string> }
function ensureSession(convId) {
  if (!SESSIONS.has(convId)) SESSIONS.set(convId, { answers: {} });
  return SESSIONS.get(convId);
}

// ---------- Field spec (LLM asks the questions) ----------
const FIELDS_SPEC = [
  { key: 'parent_name',  desc: 'Parent/guardian full name',                    priority: 1 },
  { key: 'phone',        desc: '10-digit contact number for follow-up',       priority: 1 },
  { key: 'student_name', desc: "Student's full name",                          priority: 2 },
  { key: 'grade',        desc: 'Class/grade of the student (1–12)',            priority: 2 },
  { key: 'subjects',     desc: 'Subjects that need tutoring (e.g., NEET, JEE, SAT, Math)', priority: 2 },
  { key: 'mode',         desc: 'Preferred mode: home (home tutor) or online',  priority: 3 },
  { key: 'area',         desc: 'Area/locality for home tuitions (skip if online)', priority: 3 },
  { key: 'schedule',     desc: 'Preferred days and time slots',                 priority: 3 },
  { key: 'budget',       desc: 'Monthly budget expectation',                    priority: 4 },
  { key: 'demo_consent', desc: 'Consent to arrange a free demo (yes/no)',      priority: 4 },
];

// ---------- Server-side validation (hard guard) ----------
const subjectRx = /(iit[- ]?jee|jee|neet|sat|iit[- ]?foundation|foundation|ntse|olympiad|cbse|icse|ib|school)/i;
const dayRx     = /(mon|tue|wed|thu|fri|sat|sun)/i;
const timeRx    = /\b(\d{1,2})(:\d{2})?\s*(am|pm)?\b/i;

const onlyDigits = (s='') => String(s).replace(/\D+/g,'');

function validateUpdate(key, value, lang='en'){
  const t = {
    phone: {
      en: 'Please share a valid 10-digit mobile number (digits only).',
      hi: 'कृपया 10 अंकों का सही मोबाइल नंबर भेजें (केवल अंक)।',
      te: 'దయచేసి సరైన 10 అంకెల మొబైల్ నంబర్ పంపండి (అంకెలు మాత్రమే).',
    },
    grade: {
      en: 'Which class is the student in? (1–12)',
      hi: 'विद्यार्थी किस कक्षा में है? (1–12)',
      te: 'విద్యార్థి ఏ తరగతిలో ఉన్నాడు/ఉంది? (1–12)',
    },
    mode: {
      en: 'Do you prefer **online** (Zoom 1-on-1) or **home** (offline home tuition)?',
      hi: 'आप **online** (Zoom 1-on-1) या **home** (ऑफलाइन होम ट्यूशन) चाहते हैं?',
      te: 'మీకు **online** (Zoom 1-on-1) లేదా **home** (వద్దకు వచ్చి) కావాలా?',
    },
    area: {
      en: 'Please share your area/locality (e.g., Madhapur, Kondapur).',
      hi: 'कृपया अपना क्षेत्र/लोकैलिटी बताएं (जैसे: माधापुर, कोंडापुर)।',
      te: 'దయచేసి మీ ఏరియా/లోకాలిటీ చెప్పండి (ఉదా: మాధాపూర్, కొండాపూర్).',
    },
    schedule: {
      en: 'What days and time work? (e.g., Mon–Fri 6–7pm)',
      hi: 'कौन से दिन और समय ठीक रहेंगे? (जैसे: Mon–Fri 6–7pm)',
      te: 'ఏ రోజులలో, ఏ సమయం బావుంటుంది? (ఉదా: Mon–Fri 6–7pm)',
    }
  };

  switch (key) {
    case 'phone': {
      const d = onlyDigits(value);
      if (d.length === 10) return { ok:true, value:d };
      if (d.length === 12 && d.startsWith('91')) return { ok:true, value:d.slice(2) };
      return { ok:false, prompt: t.phone[lang] || t.phone.en };
    }
    case 'grade': {
      const g = parseInt(String(value).match(/\d+/)?.[0] || '', 10);
      if (g >= 1 && g <= 12) return { ok:true, value:String(g) };
      return { ok:false, prompt: t.grade[lang] || t.grade.en };
    }
    case 'mode': {
      const v = String(value).toLowerCase();
      if (/home/.test(v)) return { ok:true, value:'home' };
      if (/online|zoom/.test(v)) return { ok:true, value:'online' };
      return { ok:false, prompt: t.mode[lang] || t.mode.en };
    }
    case 'area': {
      const s = String(value).trim();
      if (subjectRx.test(s))  // looks like "NEET"/"SAT"/"IB" etc => not an area
        return { ok:false, prompt: t.area[lang] || t.area.en };
      // simple locality check: letters/spaces/commas and at least 3 letters
      if (/[A-Za-z\u0900-\u097F\u0C00-\u0C7F]{3,}/.test(s)) return { ok:true, value:s };
      return { ok:false, prompt: t.area[lang] || t.area.en };
    }
    case 'schedule': {
      const s = String(value).toLowerCase();
      if (/^(online|home)$/.test(s)) return { ok:false, prompt: t.schedule[lang] || t.schedule.en };
      if (dayRx.test(s) || timeRx.test(s)) return { ok:true, value:String(value).trim() };
      return { ok:false, prompt: t.schedule[lang] || t.schedule.en };
    }
    default:
      return { ok:true, value: String(value).trim() };
  }
}

// ---------- LLM planner ----------
async function llmPlan({ history, knownAnswers, lang = 'en' }) {
  const langName = { en: 'English', hi: 'Hindi', te: 'Telugu' }[lang] || 'English';

  const sys = `
You are "Saras", iiTuitions' assistant. Use ONLY ${langName}. Be warm and concise (1–3 sentences).
Ask EXACTLY ONE question per turn. Do not repeat already filled fields.

When the user replies with keywords like "NEET", "JEE", "SAT", "IB", "CBSE", "ICSE", "IIT-Foundation":
- Treat them strictly as SUBJECTS (not area or schedule).

If it's the first turn, show one line then a question:
"We provide 1-on-1 tuitions: Online (Zoom) or Offline Home Tuition. We cover IIT-JEE/NEET (Gr 11–12), SAT (Gr 9–12), IIT-Foundation (from Gr 6), NTSE/Olympiads and school subjects."
`.trim();

  const tool = JSON.stringify({ fields: FIELDS_SPEC, knownAnswers, lang });

  const resp = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: `FIELDS+STATE:\n${tool}` },
      ...history,
    ],
  });

  let json = {};
  try { json = JSON.parse(resp.choices?.[0]?.message?.content || '{}'); } catch {}
  if (typeof json !== 'object' || Array.isArray(json)) json = {};
  if (!json.updates || typeof json.updates !== 'object') json.updates = {};
  if (typeof json.assistant_text !== 'string') json.assistant_text = 'Okay.';
  if (typeof json.next_field !== 'string') json.next_field = '';
  if (typeof json.done !== 'boolean') json.done = false;
  return json;
}

// ---------- Shared turn handler ----------
async function handleTurn({ convId, messages, lang, page, userAgent, resStream }) {
  const langHint = (lang === 'hi' || lang === 'te') ? lang : 'en';
  const sess = ensureSession(convId);
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');

  const plan = await llmPlan({ history: messages, knownAnswers: sess.answers, lang: langHint });

  // Validate/normalize model updates
  let badPrompt = '';
  const validated = {};
  for (const [k, v] of Object.entries(plan.updates || {})) {
    const r = validateUpdate(k, v, langHint);
    if (r.ok) validated[k] = r.value;
    else badPrompt = r.prompt;
  }
  Object.assign(sess.answers, validated);

  // mirror phone if we have a clean 10-digit
  const phone10 = onlyDigits(sess.answers.phone || '');
  const phoneClean = phone10.length === 10 ? phone10 : '';
  if (phoneClean) { try { await appendPresales({ phone: phoneClean, field: 'phone', value: phoneClean, extra: 'chat' }); } catch {} }

  const reply = badPrompt || plan.assistant_text || 'Okay.';

  try {
    await appendChatLog({ convId, role:'user', message: lastUser?.content || '', phone: phoneClean, page, userAgent, lang: langHint });
    await appendChatLog({ convId, role:'assistant', message: reply,               phone: phoneClean, page, userAgent, lang: langHint });

    // ALWAYS write to fixed first row (row 2)
    await updateLeadFixedRow({ convId, answers: sess.answers });
  } catch {}

  if (resStream) {
    resStream.write(`data: ${JSON.stringify({ reply, convId })}\n\n`);
    resStream.end();
  } else {
    return { reply, convId, answers: sess.answers };
  }
}

// ---------- Routes ----------
app.get('/health', (_req, res) => res.send('Server is Running'));

app.post('/chat', async (req, res) => {
  try {
    let { convId, messages = [], lang, page, userAgent } = req.body || {};
    if (!convId) convId = crypto.randomUUID();
    res.setHeader('x-conv-id', convId);
    const out = await handleTurn({ convId, messages, lang, page, userAgent, resStream: null });
    res.json(out);
  } catch (err) {
    console.error('chat error:', err?.response?.data || err.message);
    res.status(500).json({ error: 'chat_failed' });
  }
});

app.post('/chat_stream', async (req, res) => {
  try {
    let { convId, messages = [], lang, page, userAgent } = req.body || {};
    if (!convId) convId = crypto.randomUUID();
    res.setHeader('x-conv-id', convId);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    await handleTurn({ convId, messages, lang, page, userAgent, resStream: res });
  } catch (err) {
    console.error('chat_stream error:', err?.response?.data || err.message);
    try { res.write(`: error\n\n`); res.end(); } catch {}
  }
});

app.post('/tool/log_message', async (req, res) => {
  try {
    const { conversationId, role, text, phone, latencyMs, page, userAgent, lang } = req.body || {};
    await appendChatLog({
      convId: conversationId || '', role, message: text, phone: phone || '',
      latencyMs: latencyMs ?? '', page: page || '', userAgent: userAgent || '', lang: lang || '',
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('log_message error:', err?.response?.data || err.message);
    res.status(500).json({ ok: false });
  }
});

// ---------- Boot ----------
const port = process.env.PORT || 5000;
console.log('[cfg] PORT            =', port);
console.log('[cfg] SHEETS_CHAT_TAB =', trimQuotes(process.env.SHEETS_CHAT_TAB || 'chat_log'));
console.log('[cfg] SHEETS_LEADS_TAB=', trimQuotes(process.env.SHEETS_LEADS_TAB || 'leads'));
console.log('[cfg] LEADS_ROW_INDEX =', LEADS_ROW_INDEX);
console.log('[cfg] LANDING_DIR     =', landingDir);
app.listen(port, () => console.log(`Saras backend on :${port}`));
