import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import { KNOWLEDGE_BASE } from './knowledgeBase.js';

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Google Sheets ────────────────────────────────────────────────────────────
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME      = process.env.GOOGLE_SHEET_TAB_NAME || 'Bookings';
const BOOKING_HEADERS = ['Timestamp', 'Nama', 'No. HP', 'Tanggal', 'Jam', 'Jumlah Tamu'];
const REQUIRED_BOOKING_FIELDS = ['name', 'phone', 'date', 'time', 'guests'];

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    // .env menyimpan \n sebagai teks literal — ubah kembali jadi newline asli
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheetsClient = google.sheets({ version: 'v4', auth });

// Pastikan baris header ada — dicek sekali lalu di-cache di memori
let headerChecked = false;

function getTimestampGMT8() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Makassar',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value])
  );

  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

async function ensureHeaderRow() {
  if (headerChecked) return;

  const { data } = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:F1`,
  });

  if (!data.values || data.values.length === 0) {
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:F1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [BOOKING_HEADERS] },
    });
  }

  headerChecked = true;
}

async function appendBookingToSheet(booking) {
  await ensureHeaderRow();

  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:F`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        getTimestampGMT8(),
        booking.name,
        booking.phone,
        booking.date,
        booking.time,
        booking.guests,
      ]],
    },
  });
}

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigin = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';

app.use(cors({
  origin: allowedOrigin,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json({ limit: '2mb' }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'Le Petit Bistrot API' });
});

// ── Proxy to Anthropic ────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;

  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not found in .env' });
  }

  try {
    // Strip any system prompt sent by the client — KNOWLEDGE_BASE is always used server-side
    const { system: _ignoredSystem, model: _ignoredModel, ...clientBody } = req.body;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        ...clientBody,
        model: model || 'claude-haiku-4-5-20251001',
        system: KNOWLEDGE_BASE,
      }),
    });

    // Send status from Anthropic to client
    res.status(anthropicRes.status);

    if (req.body.stream) {
      // ── Mode streaming ───────────────────────────────────────────────────
      res.setHeader('Content-Type',  'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection',    'keep-alive');

      const reader  = anthropicRes.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value));
      }
      res.end();
    } else {
      // ── Mode non-streaming ───────────────────────────────────────────────
      const data = await anthropicRes.json();
      res.json(data);
    }
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Simpan booking terkonfirmasi ke Google Sheets ──────────────────────────────
app.post('/api/bookings', async (req, res) => {
  if (!SPREADSHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    return res.status(500).json({ error: 'Konfigurasi Google Sheets belum lengkap di .env' });
  }

  const booking = req.body || {};

  const missing = REQUIRED_BOOKING_FIELDS.filter(
    (f) => !booking[f] || String(booking[f]).trim() === ''
  );
  if (missing.length > 0) {
    return res.status(400).json({ error: `Field wajib belum lengkap: ${missing.join(', ')}` });
  }

  try {
    await appendBookingToSheet(booking);
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Gagal menyimpan booking ke Google Sheets:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Le Petit Bistrot API running on PORT :${PORT}`);
});