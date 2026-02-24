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

// YouTube channel (registered early so it's always available)
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || process.env.REACT_APP_YOUTUBE_API_KEY;
function parseChannelIdOrHandle(url) {
  if (!url || typeof url !== 'string') return null;
  const u = url.trim();
  const matchHandle = u.match(/youtube\.com\/@([^/?&#]+)/i);
  if (matchHandle) return { type: 'handle', value: matchHandle[1] };
  const matchChannel = u.match(/youtube\.com\/channel\/(UC[\w-]+)/i);
  if (matchChannel) return { type: 'channelId', value: matchChannel[1] };
  const matchCustom = u.match(/youtube\.com\/c\/([^/?&#]+)/i);
  if (matchCustom) return { type: 'customUrl', value: matchCustom[1] };
  if (/^UC[\w-]+$/i.test(u)) return { type: 'channelId', value: u };
  return null;
}
app.get('/api/youtube/channel', async (req, res) => {
  try {
    const channelUrl = req.query.url || req.query.channelUrl;
    const maxVideos = Math.min(100, Math.max(1, parseInt(req.query.maxVideos || '10', 10)));
    if (!channelUrl) return res.status(400).json({ error: 'url or channelUrl required' });
    if (!YOUTUBE_API_KEY) return res.status(503).json({ error: 'YouTube API key not configured (YOUTUBE_API_KEY)' });
    const parsed = parseChannelIdOrHandle(channelUrl);
    if (!parsed) return res.status(400).json({ error: 'Invalid channel URL. Use e.g. https://www.youtube.com/@veritasium' });
    let channelId = null;
    const base = 'https://www.googleapis.com/youtube/v3';
    if (parsed.type === 'channelId') {
      channelId = parsed.value;
    } else {
      const query = parsed.type === 'handle' ? `forHandle=${encodeURIComponent(parsed.value)}` : `forUsername=${encodeURIComponent(parsed.value)}`;
      const listRes = await fetch(`${base}/channels?part=id,snippet,contentDetails&key=${YOUTUBE_API_KEY}&${query}`);
      const listData = await listRes.json();
      if (!listData.items || listData.items.length === 0) return res.status(404).json({ error: 'Channel not found' });
      channelId = listData.items[0].id;
    }
    const channelRes = await fetch(`${base}/channels?part=snippet,contentDetails&id=${channelId}&key=${YOUTUBE_API_KEY}`);
    const channelData = await channelRes.json();
    const uploadsId = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsId) return res.status(404).json({ error: 'Channel has no uploads playlist' });
    const playlistRes = await fetch(`${base}/playlistItems?part=snippet,contentDetails&playlistId=${uploadsId}&maxResults=${maxVideos}&key=${YOUTUBE_API_KEY}`);
    const playlistData = await playlistRes.json();
    const videoIds = (playlistData.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean);
    if (videoIds.length === 0) {
      return res.json({ channelId, channelTitle: channelData.items?.[0]?.snippet?.title || '', videos: [] });
    }
    const videosRes = await fetch(`${base}/videos?part=snippet,contentDetails,statistics&id=${videoIds.join(',')}&key=${YOUTUBE_API_KEY}`);
    const videosData = await videosRes.json();
    const parseDuration = (s) => {
      if (!s || typeof s !== 'string') return null;
      const match = s.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      if (!match) return null;
      const h = parseInt(match[1] || '0', 10);
      const m = parseInt(match[2] || '0', 10);
      const sec = parseInt(match[3] || '0', 10);
      return h * 3600 + m * 60 + sec;
    };
    const videos = (videosData.items || []).map((v) => ({
      videoId: v.id,
      title: v.snippet?.title || '',
      description: v.snippet?.description || '',
      transcript: null,
      duration: v.contentDetails?.duration || null,
      durationSeconds: parseDuration(v.contentDetails?.duration),
      releaseDate: v.snippet?.publishedAt || null,
      viewCount: parseInt(v.statistics?.viewCount || '0', 10),
      likeCount: parseInt(v.statistics?.likeCount || '0', 10),
      commentCount: parseInt(v.statistics?.commentCount || '0', 10),
      videoUrl: `https://www.youtube.com/watch?v=${v.id}`,
      thumbnail: v.snippet?.thumbnails?.high?.url || v.snippet?.thumbnails?.default?.url || null,
    }));
    res.json({ channelId, channelTitle: channelData.items?.[0]?.snippet?.title || '', videos });
  } catch (err) {
    console.error('YouTube channel error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch channel' });
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

const GEMINI_API_KEY = process.env.REACT_APP_GEMINI_API_KEY || process.env.GEMINI_API_KEY;

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
