import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app  = express();
const PORT = process.env.PORT || 3001;

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

// ── Proxy ke Anthropic ────────────────────────────────────────────────────────
app.post('api/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not found in .env' });
  }

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':'application/json',
        'x-api-key':apiKey,
        'anthropic-version':'2023-06-01',
        'anthropic-beta':'prompt-caching-2024-07-31',
      },
      body: JSON.stringify(req.body),
    });

    // Teruskan status dari Anthropic ke client
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

app.listen(PORT, () => {
  console.log(`✅ Le Petit Bistrot API running on PORT :${PORT}`);
});