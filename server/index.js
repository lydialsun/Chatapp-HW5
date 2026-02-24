const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const URI = process.env.REACT_APP_MONGODB_URI || process.env.MONGODB_URI || process.env.REACT_APP_MONGO_URI;
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
          <p><a href="/api/youtube/channel?url=https://www.youtube.com/@veritasium&maxVideos=1" style="color:#ffd700">Test YouTube channel</a></p>
        </div>
      </body>
    </html>
  `);
});

// YouTube channel (uses shared fetch logic; all video URLs are real)
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || process.env.REACT_APP_YOUTUBE_API_KEY;
const GEMINI_API_KEY = process.env.REACT_APP_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
const { fetchYouTubeChannelData } = require('./youtubeChannel');

app.get('/api/youtube/channel', async (req, res) => {
  try {
    const channelUrl = req.query.url || req.query.channelUrl;
    const maxVideos = Math.min(100, Math.max(1, parseInt(req.query.maxVideos || '10', 10)));
    if (!channelUrl) return res.status(400).json({ error: 'url or channelUrl required' });
    if (!YOUTUBE_API_KEY) return res.status(503).json({ error: 'YouTube API key not configured (YOUTUBE_API_KEY)' });
    const data = await fetchYouTubeChannelData(channelUrl, maxVideos, YOUTUBE_API_KEY);
    res.json(data);
  } catch (err) {
    console.error('YouTube channel error:', err);
    const status = err.message?.includes('not found') ? 404 : err.message?.includes('Invalid') ? 400 : 500;
    res.status(status).json({ error: err.message || 'Failed to fetch channel' });
  }
});

// YouTube channel via Gemini + Google Search (no YouTube API key required)
app.post('/api/youtube/channel-gemini', async (req, res) => {
  try {
    const { channelUrl, maxVideos: rawMax } = req.body;
    const maxVideos = Math.min(100, Math.max(1, parseInt(rawMax || '10', 10)));
    if (!channelUrl || typeof channelUrl !== 'string') return res.status(400).json({ error: 'channelUrl required' });
    if (!GEMINI_API_KEY) return res.status(503).json({ error: 'Gemini API key not configured (REACT_APP_GEMINI_API_KEY)' });

    const prompt = `Use Google Search to find the YouTube channel at this URL: ${channelUrl}

For the channel, find up to ${maxVideos} of its most recent videos. For each video, search for and provide:
- title
- description (short summary if full not available)
- transcript (if publicly available; otherwise null)
- duration (ISO 8601 e.g. PT10M30S)
- durationSeconds (number, optional)
- releaseDate (ISO 8601 date string)
- viewCount (number)
- likeCount (number)
- commentCount (number)
- videoUrl (full https://www.youtube.com/watch?v=VIDEO_ID URL)
- videoId (the id from the URL)
- thumbnail (optional: https://i.ytimg.com/vi/VIDEO_ID/hqdefault.jpg)

Respond with ONLY a single valid JSON object, no other text or markdown. Use this exact structure:
{"channelId":"","channelTitle":"","videos":[{"videoId":"","title":"","description":"","transcript":null,"duration":"","durationSeconds":null,"releaseDate":"","viewCount":0,"likeCount":0,"commentCount":0,"videoUrl":"","thumbnail":""}]}
If you cannot find a channel or videos, return {"channelId":"","channelTitle":"","videos":[]}.`;

    const genUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const genRes = await fetch(genUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json',
        },
      }),
    });
    const genData = await genRes.json();

    if (!genRes.ok) {
      const errMsg = genData.error?.message || JSON.stringify(genData.error || genData);
      console.error('Gemini channel error:', genRes.status, errMsg);
      return res.status(genRes.status >= 500 ? 503 : 400).json({ error: errMsg });
    }

    const text = genData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text || typeof text !== 'string') {
      return res.status(500).json({ error: 'No text in Gemini response' });
    }

    let data;
    try {
      const cleaned = text.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/m, '$1').trim();
      data = JSON.parse(cleaned);
    } catch (e) {
      console.error('Gemini channel JSON parse error:', e.message, text.slice(0, 500));
      return res.status(500).json({ error: 'Could not parse channel data from response' });
    }

    if (!data.videos || !Array.isArray(data.videos)) {
      data.videos = [];
    }
    data.channelId = data.channelId || '';
    data.channelTitle = data.channelTitle || '';

    res.json(data);
  } catch (err) {
    console.error('YouTube channel (Gemini) error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch channel via Gemini' });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const usersCount = await db.collection('users').countDocuments();
    const sessionsCount = await db.collection('sessions').countDocuments();
    res.json({ usersCount, sessionsCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Users ────────────────────────────────────────────────────────────────────

app.post('/api/users', async (req, res) => {
  try {
    const { username, password, email, firstName, lastName } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });
    const name = String(username).trim().toLowerCase();
    const existing = await db.collection('users').findOne({ username: name });
    if (existing) return res.status(400).json({ error: 'Username already exists' });
    const hashed = await bcrypt.hash(password, 10);
    await db.collection('users').insertOne({
      username: name,
      password: hashed,
      email: email ? String(email).trim().toLowerCase() : null,
      firstName: firstName ? String(firstName).trim() : null,
      lastName: lastName ? String(lastName).trim() : null,
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
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid password' });
    res.json({
      ok: true,
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

// ── Image generation (Gemini) ──────────────────────────────────────────────

app.post('/api/generate-image', async (req, res) => {
  try {
    const { prompt, anchorImageBase64, anchorMimeType } = req.body;
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt required' });
    if (!GEMINI_API_KEY) return res.status(503).json({ error: 'Gemini API key not configured' });

    const parts = [{ text: prompt }];
    if (anchorImageBase64) {
      parts.push({
        inlineData: {
          mimeType: anchorMimeType || 'image/png',
          data: anchorImageBase64.replace(/^data:image\/\w+;base64,/, ''),
        },
      });
    }

    // Image generation requires a model that supports IMAGE output (e.g. Gemini 2.5 Flash Image)
    const imageModel = 'gemini-2.5-flash-image';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${imageModel}:generateContent`;
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        responseMimeType: 'text/plain',
      },
    };

    const genRes = await fetch(`${url}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const genData = await genRes.json();

    if (!genRes.ok) {
      const errMsg = genData.error?.message || genData.error?.status || JSON.stringify(genData.error || genData);
      console.error('Image API error:', genRes.status, errMsg);
      return res.status(genRes.status >= 500 ? 503 : 400).json({
        error: errMsg,
        hint: 'Image generation uses gemini-2.5-flash-image. Ensure your API key has access in Google AI Studio (aistudio.google.com).',
      });
    }

    const candidate = genData.candidates?.[0];
    if (!candidate) {
      const errMsg = genData.error?.message || 'No candidate in response';
      return res.status(400).json({ error: errMsg });
    }
    const part = candidate.content?.parts?.find((p) => p.inlineData);
    if (!part?.inlineData?.data) {
      return res.status(400).json({
        error: 'No image in response. The model may not support image generation with your request.',
        hint: 'Try a text-only prompt or ensure you are using an image-capable model in Google AI Studio.',
      });
    }
    res.json({ imageBase64: part.inlineData.data, mimeType: part.inlineData.mimeType || 'image/png' });
  } catch (err) {
    console.error('Image generation error:', err);
    res.status(500).json({ error: err.message || 'Image generation failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

connect()
  .then(() => {
    app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
