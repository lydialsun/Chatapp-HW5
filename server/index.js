const path = require('path');
const fs = require('fs');
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });
else require('dotenv').config();
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');
const BUILD_VERSION = 'image-anchor-fix-v2';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Strip surrounding quotes from env vars (e.g. REACT_APP_GEMINI_API_KEY="AIza...")
function stripEnvQuotes(s) {
  if (typeof s !== 'string') return s;
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    return t.slice(1, -1).trim();
  return t;
}

const URI = stripEnvQuotes(process.env.REACT_APP_MONGODB_URI || process.env.MONGODB_URI || process.env.REACT_APP_MONGO_URI || '');
const DB = 'chatapp';

let db;

async function connect() {
  const client = await MongoClient.connect(URI);
  db = client.db(DB);
  console.log('MongoDB connected');
}

app.get('/', (req, res) => {
  res.send(`
    <html>
      <body style="font-family:sans-serif;padding:2rem;background:#00356b;color:white;min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0">
        <div style="text-align:center">
          <h1>Chat API Server</h1>
          <p>Backend is running. Use the React app at <a href="http://localhost:3000" style="color:#ffd700">localhost:3000</a></p>
          <p><a href="/api/status" style="color:#ffd700">Check DB status</a></p>
          <p><a href="/api/youtube/download-channel" style="color:#ffd700">Use POST /api/youtube/download-channel</a></p>
        </div>
      </body>
    </html>
  `);
});

const GEMINI_API_KEY = stripEnvQuotes(process.env.REACT_APP_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '') || null;
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;
const { scrapeYouTubeChannelData } = require('./youtubeScrape');

// Assignment-compatible download route (scraper only; no yt-dlp)
app.post('/api/youtube/download-channel', async (req, res) => {
  try {
    const { channelUrl, maxVideos: rawMax } = req.body || {};
    const maxVideos = Math.min(100, Math.max(1, parseInt(rawMax || '10', 10)));
    if (!channelUrl || typeof channelUrl !== 'string') return res.status(400).json({ error: 'channelUrl required' });
    const payload = await scrapeYouTubeChannelData(channelUrl, maxVideos);

    res.setHeader('Content-Disposition', 'attachment; filename=channel_data.json');
    return res.json(payload);
  } catch (err) {
    console.error('YouTube download-channel error:', err);
    const msg = err.message || 'Failed to download channel data';
    const status =
      msg.includes('ytInitialData not found') || msg.includes('Invalid YouTube channel URL')
        ? 400
        : msg.includes('No videos found')
          ? 404
          : msg.includes('parse')
            ? 400
            : 500;
    return res.status(status).json({ error: err.message || 'Failed to download channel data' });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const usersCount = await db.collection('users').countDocuments();
    const sessionsCount = await db.collection('sessions').countDocuments();
    res.json({
      usersCount,
      sessionsCount,
      geminiKeyConfigured: !!GEMINI_API_KEY,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Users ────────────────────────────────────────────────────────────────────

app.post('/api/users', async (req, res) => {
  try {
    const { username, password, email, firstName, lastName } = req.body;
    if (!username || !password || !firstName || !lastName)
      return res.status(400).json({ error: 'Username, password, firstName, and lastName are required' });
    const name = String(username).trim().toLowerCase();
    const existing = await db.collection('users').findOne({ username: name });
    if (existing) return res.status(400).json({ error: 'Username already exists' });
    const hashed = await bcrypt.hash(password, 10);
    await db.collection('users').insertOne({
      username: name,
      password: hashed,
      email: email ? String(email).trim().toLowerCase() : null,
      firstName: String(firstName).trim(),
      lastName: String(lastName).trim(),
      createdAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });
    const name = username.trim().toLowerCase();
    const user = await db.collection('users').findOne({ username: name });
    if (!user) return res.status(401).json({ error: 'User not found' });
    const storedPassword = typeof user.password === 'string' ? user.password : '';
    let ok = false;
    if (storedPassword.startsWith('$2')) {
      ok = await bcrypt.compare(password, storedPassword);
    } else if (storedPassword === password) {
      // Backward compatibility for legacy/plaintext rows: allow login once, then migrate.
      ok = true;
      const hashed = await bcrypt.hash(password, 10);
      await db.collection('users').updateOne(
        { _id: user._id },
        { $set: { password: hashed } }
      );
    } else {
      return res.status(401).json({ error: 'Invalid password' });
    }
    if (!ok) return res.status(401).json({ error: 'Invalid password' });
    res.json({
      ok: true,
      _id: user._id?.toString(),
      username: name,
      firstName: user.firstName || null,
      lastName: user.lastName || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sessions ─────────────────────────────────────────────────────────────────

app.get('/api/sessions', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: 'username required' });
    const sessions = await db
      .collection('sessions')
      .find({ username })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(
      sessions.map((s) => ({
        id: s._id.toString(),
        agent: s.agent || null,
        title: s.title || null,
        createdAt: s.createdAt,
        messageCount: (s.messages || []).length,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions', async (req, res) => {
  try {
    const { username, agent } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    const { title } = req.body;
    const result = await db.collection('sessions').insertOne({
      username,
      agent: agent || null,
      title: title || null,
      createdAt: new Date().toISOString(),
      messages: [],
    });
    res.json({ id: result.insertedId.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  try {
    await db.collection('sessions').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/sessions/:id/title', async (req, res) => {
  try {
    const { title } = req.body;
    await db.collection('sessions').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { title } }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Messages ─────────────────────────────────────────────────────────────────

app.post('/api/messages', async (req, res) => {
  try {
    const { session_id, role, content, imageData, charts, toolCalls } = req.body;
    if (!session_id || !role || content === undefined)
      return res.status(400).json({ error: 'session_id, role, content required' });
    const msg = {
      role,
      content,
      timestamp: new Date().toISOString(),
      ...(imageData && {
        imageData: Array.isArray(imageData) ? imageData : [imageData],
      }),
      ...(charts?.length && { charts }),
      ...(toolCalls?.length && { toolCalls }),
    };
    await db.collection('sessions').updateOne(
      { _id: new ObjectId(session_id) },
      { $push: { messages: msg } }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages', async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'session_id required' });
    const doc = await db
      .collection('sessions')
      .findOne({ _id: new ObjectId(session_id) });
    const raw = doc?.messages || [];
    const msgs = raw.map((m, i) => {
      const arr = m.imageData
        ? Array.isArray(m.imageData)
          ? m.imageData
          : [m.imageData]
        : [];
      return {
        id: `${doc._id}-${i}`,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        images: arr.length
          ? arr.map((img) => ({ data: img.data, mimeType: img.mimeType }))
          : undefined,
        charts: m.charts?.length ? m.charts : undefined,
        toolCalls: m.toolCalls?.length ? m.toolCalls : undefined,
      };
    });
    res.json(msgs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function handleGenerateImage(req, res) {
  const requestId = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const startedAt = Date.now();
    const startedIso = new Date(startedAt).toISOString();
    const { prompt, anchorImageBase64, anchorMimeType } = req.body;
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt required' });
    if (!GEMINI_API_KEY) return res.status(503).json({ error: 'Gemini API key not configured', code: 'GEMINI_KEY_NOT_CONFIGURED' });
    if (!ai) return res.status(503).json({ error: 'Gemini client unavailable', code: 'GEMINI_CLIENT_UNAVAILABLE' });

    const parts = [{ text: prompt.trim() }];
    const useAnchorImage = anchorImageBase64 !== undefined && anchorImageBase64 !== null;
    if (useAnchorImage) {
      if (typeof anchorImageBase64 !== 'string' || !anchorImageBase64.trim()) {
        return res.status(400).json({ error: 'Invalid anchorImageBase64', requestId, build: BUILD_VERSION });
      }
      const raw = String(anchorImageBase64 || '');
      const b64 = raw.includes('base64,') ? raw.split('base64,')[1] : raw;
      if (!b64 || b64.trim().length < 50) {
        return res.status(400).json({ error: 'Invalid anchorImageBase64', requestId, build: BUILD_VERSION });
      }

      const bytes = Buffer.from(b64, 'base64');
      if (!bytes || bytes.length < 10) {
        return res.status(400).json({ error: 'Anchor image bytes empty', requestId, build: BUILD_VERSION });
      }
      console.log('[generateImage] anchor bytes length', bytes.length, 'mime', anchorMimeType || 'image/png');
      parts.push({
        inline_data: {
          mime_type: anchorMimeType || 'image/png',
          data: bytes,
        },
      });
    }

    const hasAnchor = Boolean(anchorImageBase64);
    const MODELS = hasAnchor
      ? ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview']
      : ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview'];
    const backendTimeoutMs = Math.max(10000, parseInt(process.env.IMAGE_TIMEOUT_MS || '65000', 10));

    const runModelOnce = async (modelName) => Promise.race([
      ai.models.generateContent({
        model: modelName,
        contents: [{ role: 'user', parts }],
        config: {
          response_modalities: ['IMAGE'],
        },
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Gemini timeout')), backendTimeoutMs);
      }),
    ]);

    let response = null;
    let modelUsed = null;
    let lastErr = null;
    console.log(`[generateImage] requestId=${requestId} start=${startedIso} hasAnchor=${hasAnchor} models=${MODELS.join(',')}`);
    for (const modelName of MODELS) {
      try {
        response = await runModelOnce(modelName);
        modelUsed = modelName;
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`[generateImage] requestId=${requestId} model failed model=${modelName} err=${e?.message || e}`);
      }
    }
    if (!response || !modelUsed) {
      throw lastErr || new Error('Image generation failed');
    }
    console.log(`[generateImage] requestId=${requestId} response_ms=${Date.now() - startedAt} model=${modelUsed}`);

    const candidate = response?.candidates?.[0];
    const responseParts = candidate?.content?.parts ?? [];
    const imgPart = responseParts.find((p) => p?.inline_data?.data || p?.inlineData?.data);
    const bytes = imgPart?.inline_data?.data || imgPart?.inlineData?.data;

    if (!bytes) {
      const partsSummary = responseParts.map((p) => ({
        hasText: typeof p?.text === 'string' && p.text.length > 0,
        hasInlineData: Boolean(p?.inline_data || p?.inlineData),
        mimeType: p?.inline_data?.mime_type || p?.inlineData?.mimeType || null,
      }));
      return res.status(400).json({
        error: 'No image returned from Gemini',
        requestId,
        modelUsed,
        finishReason: candidate?.finishReason || null,
        partsSummary,
      });
    }

    let imageBase64;
    if (typeof bytes === 'string') imageBase64 = bytes;
    else imageBase64 = Buffer.from(bytes).toString('base64');
    console.log(`[generateImage] requestId=${requestId} success_ms=${Date.now() - startedAt}`);
    return res.json({
      imageBase64,
      mimeType: 'image/png',
      modelUsed,
      build: BUILD_VERSION,
    });
  } catch (err) {
    console.error(`[generateImage] requestId=${requestId} error:`, err);
    const msg = err?.message || 'Image generation failed';
    const status =
      msg.includes('timeout')
        ? 504
        : (msg.includes('not found') || msg.includes('No image in response') ? 400 : 500);
    return res.status(status).json({
      error: msg,
      requestId,
      build: BUILD_VERSION,
    });
  }
}

app.post('/api/generate-image', handleGenerateImage);
app.post('/api/tools/generateImage', handleGenerateImage);
app.get('/api/tools/generateImage/ping', (req, res) => res.json({ ok: true }));

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

connect()
  .then(() => {
    console.log('SERVER BUILD:', BUILD_VERSION);
    app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
