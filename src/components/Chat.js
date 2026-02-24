import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { streamChat, chatWithCsvTools, chatWithYouTubeTools } from '../services/gemini';
import { parseCsvToRows, executeTool, computeDatasetSummary, enrichWithEngagement, buildSlimCsv } from '../services/csvTools';
import { executeYouTubeTool } from '../services/youtubeTools';
import { normalizeVideosReleaseDates } from '../services/dateNormalization';
import {
  getSessions,
  createSession,
  deleteSession,
  saveMessage,
  loadMessages,
  generateImage as apiGenerateImage,
} from '../services/mongoApi';
import EngagementChart from './EngagementChart';
import MetricVsTimeChart from './MetricVsTimeChart';
import PlayVideoCard from './PlayVideoCard';
import GeneratedImage from './GeneratedImage';
import StatsJsonCard from './StatsJsonCard';
import './Chat.css';

// ── Helpers ───────────────────────────────────────────────────────────────────

const chatTitle = () => {
  const d = new Date();
  return `Chat · ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

// Encode a string to base64 safely (handles unicode/emoji in tweet text etc.)
const toBase64 = (str) => {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

const parseCSV = (text) => {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return null;
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const rowCount = lines.length - 1;

  // Short human-readable preview (header + first 5 rows) for context
  const preview = lines.slice(0, 6).join('\n');

  // Full CSV as base64 — avoids ALL string-escaping issues in Python code execution
  // (tweet text with quotes, apostrophes, emojis, etc. all break triple-quoted strings)
  const raw = text.length > 500000 ? text.slice(0, 500000) : text;
  const base64 = toBase64(raw);
  const truncated = text.length > 500000;

  return { headers, rowCount, preview, base64, truncated };
};

// Normalize channel JSON: accept snake_case (video_url, video_id, etc.) and ensure camelCase for tools
function normalizeChannelVideos(videos) {
  if (!Array.isArray(videos)) return [];
  const mapped = videos.map((v) => ({
    ...v,
    videoId: v.videoId ?? v.video_id,
    title: v.title,
    description: v.description,
    transcript: v.transcript,
    duration: v.duration,
    durationSeconds:
      v.durationSeconds ??
      (typeof v.duration_seconds === 'number'
        ? v.duration_seconds
        : (typeof v.duration === 'number' ? v.duration : undefined)),
    releaseDate: v.releaseDate ?? v.release_date,
    viewCount: v.viewCount ?? v.view_count,
    likeCount: v.likeCount ?? v.like_count,
    commentCount: v.commentCount ?? v.comment_count,
    videoUrl: v.videoUrl ?? v.video_url,
    thumbnail: v.thumbnail ?? v.thumbnail_url,
  }));
  const { videos: normalized, normalizedCount, invalidCount } = normalizeVideosReleaseDates(mapped);
  console.warn(`[channel-json] normalized release dates: ok=${normalizedCount}, invalid=${invalidCount}`);
  return normalized;
}

// Extract plain text from a message (for history only — never returns base64)
const messageText = (m) => {
  if (m.parts) return m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  return m.content || '';
};

// ── Structured part renderer (code execution responses) ───────────────────────

function StructuredParts({ parts }) {
  return (
    <>
      {parts.map((part, i) => {
        if (part.type === 'text' && part.text?.trim()) {
          return (
            <div key={i} className="part-text">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
            </div>
          );
        }
        if (part.type === 'code') {
          return (
            <div key={i} className="part-code">
              <div className="part-code-header">
                <span className="part-code-lang">
                  {part.language === 'PYTHON' ? 'Python' : part.language}
                </span>
              </div>
              <pre className="part-code-body">
                <code>{part.code}</code>
              </pre>
            </div>
          );
        }
        if (part.type === 'result') {
          const ok = part.outcome === 'OUTCOME_OK';
          return (
            <div key={i} className="part-result">
              <div className="part-result-header">
                <span className={`part-result-badge ${ok ? 'ok' : 'err'}`}>
                  {ok ? '✓ Output' : '✗ Error'}
                </span>
              </div>
              <pre className="part-result-body">{part.output}</pre>
            </div>
          );
        }
        if (part.type === 'image') {
          return (
            <img
              key={i}
              src={`data:${part.mimeType};base64,${part.data}`}
              alt="Generated plot"
              className="part-image"
            />
          );
        }
        return null;
      })}
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Chat({ user, onLogout }) {
  const username = user?.username ?? '';
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [images, setImages] = useState([]);
  const [csvContext, setCsvContext] = useState(null);
  const [sessionCsvRows, setSessionCsvRows] = useState(null);
  const [sessionCsvHeaders, setSessionCsvHeaders] = useState(null);
  const [csvDataSummary, setCsvDataSummary] = useState(null);
  const [sessionSlimCsv, setSessionSlimCsv] = useState(null);
  const [channelJsonData, setChannelJsonData] = useState(null);
  const [channelJsonFileName, setChannelJsonFileName] = useState(null);
  const [channelLoadNotice, setChannelLoadNotice] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [openMenuId, setOpenMenuId] = useState(null);

  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(false);
  const fileInputRef = useRef(null);
  // Set to true immediately before setActiveSessionId() is called during a send
  // so the messages useEffect knows to skip the reload (streaming is in progress).
  const justCreatedSessionRef = useRef(false);

  const withTimeout = (p, ms = 90000) =>
    Promise.race([
      p,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Image generation timed out')), ms)
      ),
    ]);

  // On login: load sessions from DB; 'new' means an unsaved pending chat
  useEffect(() => {
    const init = async () => {
      try {
        const list = await getSessions(username);
        setSessions(list);
      } catch (err) {
        console.error('[chat] failed to load sessions:', err);
        setSessions([]);
      }
      setActiveSessionId('new'); // always start with a fresh empty chat on login
    };
    init();
  }, [username]);

  useEffect(() => {
    if (!activeSessionId || activeSessionId === 'new') {
      setMessages([]);
      return;
    }
    // If a session was just created during an active send, messages are already
    // in state and streaming is in progress — don't wipe them.
    if (justCreatedSessionRef.current) {
      justCreatedSessionRef.current = false;
      return;
    }
    setMessages([]);
    loadMessages(activeSessionId)
      .then(setMessages)
      .catch((err) => {
        console.error('[chat] failed to load messages:', err);
        setMessages([]);
      });
  }, [activeSessionId]);

  useEffect(() => {
    if (activeSessionId !== 'new') return;
    if (messages.length > 0) return;
    const firstName = user?.firstName || user?.username || 'there';
    setMessages([
      {
        id: `welcome-${Date.now()}`,
        role: 'model',
        content: `Hi ${firstName}, I can help analyze YouTube channel data, generate images, plot metrics over time, play videos, and compute stats.`,
        timestamp: new Date().toISOString(),
      },
    ]);
  }, [activeSessionId, messages.length, user?.firstName, user?.username]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('youtube_channel_data');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const videos = normalizeChannelVideos(parsed?.videos || []);
      if (!Array.isArray(videos) || !videos.length) return;
      setChannelJsonData({ channelTitle: parsed?.channelTitle || parsed?.channel?.channelTitle || '', videos });
      setChannelJsonFileName(parsed?.fileName || 'youtube_channel_data.json');
    } catch {
      // Ignore malformed localStorage payloads.
    }
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!openMenuId) return;
    const handler = () => setOpenMenuId(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [openMenuId]);

  // ── Session management ──────────────────────────────────────────────────────

  const handleNewChat = () => {
    setActiveSessionId('new');
    setMessages([]);
    setInput('');
    setImages([]);
    setCsvContext(null);
    setSessionCsvRows(null);
    setSessionCsvHeaders(null);
    setChannelJsonData(null);
    setChannelJsonFileName(null);
  };

  const handleSelectSession = (sessionId) => {
    if (sessionId === activeSessionId) return;
    setActiveSessionId(sessionId);
    setInput('');
    setImages([]);
    setCsvContext(null);
    setSessionCsvRows(null);
    setSessionCsvHeaders(null);
  };

  const handleDeleteSession = async (sessionId, e) => {
    e.stopPropagation();
    setOpenMenuId(null);
    await deleteSession(sessionId);
    const remaining = sessions.filter((s) => s.id !== sessionId);
    setSessions(remaining);
    if (activeSessionId === sessionId) {
      setActiveSessionId(remaining.length > 0 ? remaining[0].id : 'new');
      setMessages([]);
    }
  };

  // ── File handling ───────────────────────────────────────────────────────────

  const fileToBase64 = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result.split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(file);
    });

  const fileToText = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsText(file);
    });

  const handleDrop = async (e) => {
    e.preventDefault();
    setDragOver(false);
    const files = [...e.dataTransfer.files];

    const csvFiles = files.filter((f) => f.name.endsWith('.csv') || f.type === 'text/csv');
    const jsonFiles = files.filter((f) => f.name.endsWith('.json') || f.type === 'application/json');
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));

    if (jsonFiles.length > 0) {
      try {
        const text = await fileToText(jsonFiles[0]);
        const data = JSON.parse(text);
        const rawVideos = data?.videos;
        if (!Array.isArray(rawVideos)) throw new Error('JSON must include a "videos" array');
        const videos = normalizeChannelVideos(rawVideos);
        const channelTitle = data.channelTitle || data.channel_title || '';
        setChannelJsonData({ channelTitle, videos });
        setChannelJsonFileName(jsonFiles[0].name);
        setChannelLoadNotice(`Loaded channel data: ${videos.length} videos`);
        localStorage.setItem('youtube_channel_data', JSON.stringify({ channelTitle, videos, fileName: jsonFiles[0].name }));
      } catch (err) {
        console.error('Invalid JSON file', err);
        setChannelLoadNotice('Invalid JSON. Expected shape: { "videos": [ ... ] }');
      }
    }

    if (csvFiles.length > 0) {
      const file = csvFiles[0];
      const text = await fileToText(file);
      const parsed = parseCSV(text);
      if (parsed) {
        setCsvContext({ name: file.name, ...parsed });
        // Parse rows, add computed engagement col, build summary + slim CSV
        const raw = parseCsvToRows(text);
        const { rows, headers } = enrichWithEngagement(raw.rows, raw.headers);
        setSessionCsvHeaders(headers);
        setSessionCsvRows(rows);
        setCsvDataSummary(computeDatasetSummary(rows, headers));
        setSessionSlimCsv(buildSlimCsv(rows, headers));
      }
    }

    if (imageFiles.length > 0) {
      const newImages = await Promise.all(
        imageFiles.map(async (f) => ({
          data: await fileToBase64(f),
          mimeType: f.type,
          name: f.name,
        }))
      );
      setImages((prev) => [...prev, ...newImages]);
    }
  };

  const handleFileSelect = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';

    const csvFiles = files.filter((f) => f.name.endsWith('.csv') || f.type === 'text/csv');
    const jsonFiles = files.filter((f) => f.name.endsWith('.json') || f.type === 'application/json');
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));

    if (jsonFiles.length > 0) {
      try {
        const text = await fileToText(jsonFiles[0]);
        const data = JSON.parse(text);
        const rawVideos = data?.videos;
        if (!Array.isArray(rawVideos)) throw new Error('JSON must include a "videos" array');
        const videos = normalizeChannelVideos(rawVideos);
        const channelTitle = data.channelTitle || data.channel_title || '';
        setChannelJsonData({ channelTitle, videos });
        setChannelJsonFileName(jsonFiles[0].name);
        setChannelLoadNotice(`Loaded channel data: ${videos.length} videos`);
        localStorage.setItem('youtube_channel_data', JSON.stringify({ channelTitle, videos, fileName: jsonFiles[0].name }));
      } catch (err) {
        console.error('Invalid JSON file', err);
        setChannelLoadNotice('Invalid JSON. Expected shape: { "videos": [ ... ] }');
      }
    }

    if (csvFiles.length > 0) {
      const text = await fileToText(csvFiles[0]);
      const parsed = parseCSV(text);
      if (parsed) {
        setCsvContext({ name: csvFiles[0].name, ...parsed });
        const raw = parseCsvToRows(text);
        const { rows, headers } = enrichWithEngagement(raw.rows, raw.headers);
        setSessionCsvHeaders(headers);
        setSessionCsvRows(rows);
        setCsvDataSummary(computeDatasetSummary(rows, headers));
        setSessionSlimCsv(buildSlimCsv(rows, headers));
      }
    }
    if (imageFiles.length > 0) {
      const newImages = await Promise.all(
        imageFiles.map(async (f) => ({
          data: await fileToBase64(f),
          mimeType: f.type,
          name: f.name,
        }))
      );
      setImages((prev) => [...prev, ...newImages]);
    }
  };

  // ── Stop generation ─────────────────────────────────────────────────────────

  const handlePaste = async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter((item) => item.type.startsWith('image/'));
    if (!imageItems.length) return;
    e.preventDefault();
    const newImages = await Promise.all(
      imageItems.map(
        (item) =>
          new Promise((resolve) => {
            const file = item.getAsFile();
            if (!file) return resolve(null);
            const reader = new FileReader();
            reader.onload = () =>
              resolve({ data: reader.result.split(',')[1], mimeType: file.type, name: 'pasted-image' });
            reader.readAsDataURL(file);
          })
      )
    );
    setImages((prev) => [...prev, ...newImages.filter(Boolean)]);
  };

  const handleStop = () => {
    abortRef.current = true;
  };

  // ── Send message ────────────────────────────────────────────────────────────

  const handleSend = async () => {
    const text = input.trim();
    if ((!text && !images.length && !csvContext && !channelJsonData) || streaming || !activeSessionId) return;

    // Lazily create the session in DB on the very first message
    let sessionId = activeSessionId;
    if (sessionId === 'new') {
      const title = chatTitle();
      const { id } = await createSession(username, 'lisa', title);
      sessionId = id;
      justCreatedSessionRef.current = true; // tell useEffect to skip the reload
      setActiveSessionId(id);
      setSessions((prev) => [{ id, agent: 'lisa', title, createdAt: new Date().toISOString(), messageCount: 0 }, ...prev]);
    }

    const videos = channelJsonData?.videos ?? [];
    const hasAnchor = images.length > 0;
    const wantsImageGeneration =
      /\b(generate|create|draw|make|paint)\s+(an?\s+)?(image|picture|photo)\b/i.test(text) ||
      /\bgenerateImage\b/i.test(text) ||
      /\bimage\s+generation\b/i.test(text) ||
      (images.length > 0 && /\b(generate|create|draw|style|transform|based on this)\b/i.test(text));
    const directImageIntent = /\bgenerate an image|draw|create an image|make an image\b/i.test(text);
    const useYouTubeTools = videos.length > 0;
    const useImageTools = wantsImageGeneration || hasAnchor || directImageIntent;

    const capturedCsv = csvContext;
    const needsBase64 = false;
    const useTools = !!sessionCsvRows && !capturedCsv && !useYouTubeTools;

    // ── Build prompt ─────────────────────────────────────────────────────────
    const userName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.username || '';
    const userContextLine = userName
      ? `[User: ${userName}]\nThe user you are speaking to is ${userName}.\n\n`
      : '';

    const MAX_CSV_CONTEXT_CHARS = 40000;
    const sessionSummary = (csvDataSummary || '').length > MAX_CSV_CONTEXT_CHARS
      ? (csvDataSummary || '').slice(0, MAX_CSV_CONTEXT_CHARS) + '\n\n[... truncated for length ...]'
      : (csvDataSummary || '');
    const slimCsv = (sessionSlimCsv || '').length > MAX_CSV_CONTEXT_CHARS
      ? (sessionSlimCsv || '').slice(0, MAX_CSV_CONTEXT_CHARS) + '\n\n[... truncated ...]'
      : (sessionSlimCsv || '');
    const slimCsvBlock = slimCsv
      ? `\n\nFull dataset (key columns):\n\`\`\`csv\n${slimCsv}\n\`\`\``
      : '';

    const MAX_VIDEOS_IN_PROMPT = 50;
    const videoListForPrompt = videos.slice(0, MAX_VIDEOS_IN_PROMPT);
    const videoListSuffix = videos.length > MAX_VIDEOS_IN_PROMPT ? `\n... and ${videos.length - MAX_VIDEOS_IN_PROMPT} more videos (use play_video by title or ordinal).` : '';
    const jsonContextBlock =
      useYouTubeTools && videos.length
        ? `[YouTube channel JSON loaded: "${channelJsonData?.channelTitle || 'Channel'}" with ${videos.length} videos. Use ONLY these videos and their URLs when answering or calling play_video — never invent a URL.\n\nLightweight video metadata (index 1-based):\n${videoListForPrompt.map((v, i) => `${i + 1}. title="${v.title || 'Untitled'}" | releaseDate="${v.releaseDate || v.release_date || ''}" | viewCount=${v.viewCount ?? 0} | likeCount=${v.likeCount ?? 0} | commentCount=${v.commentCount ?? 0} | duration=${v.duration ?? ''} | videoUrl="${v.videoUrl || `https://www.youtube.com/watch?v=${v.videoId || ''}`}"`).join('\n')}${videoListSuffix}\n]\n\n`
        : useYouTubeTools && wantsImageGeneration
          ? '[No channel data loaded. You have the generateImage tool only — use it to generate an image from the user\'s prompt or from an image they attached.]\n\n'
          : '';

    const csvPrefix = capturedCsv
      ? needsBase64
        // Python path: send base64 so Gemini can load it with pandas
        ? `[CSV File: "${capturedCsv.name}" | ${capturedCsv.rowCount} rows | Columns: ${capturedCsv.headers.join(', ')}]

${sessionSummary}${slimCsvBlock}

IMPORTANT — to load the full data in Python use this exact pattern:
\`\`\`python
import pandas as pd, io, base64
df = pd.read_csv(io.BytesIO(base64.b64decode("${capturedCsv.base64}")))
\`\`\`

---

`
        // Standard path: plain CSV text — no encoding needed
        : `[CSV File: "${capturedCsv.name}" | ${capturedCsv.rowCount} rows | Columns: ${capturedCsv.headers.join(', ')}]

${sessionSummary}${slimCsvBlock}

---

`
      : sessionSummary
      ? `[CSV columns: ${sessionCsvHeaders?.join(', ')}]\n\n${sessionSummary}\n\n---\n\n`
      : '';

    const userContent = text || (images.length ? '(Image)' : csvContext ? '(CSV attached)' : channelJsonData ? '(Channel JSON attached)' : '');
    const promptForGemini =
      userContextLine +
      jsonContextBlock +
      csvPrefix +
      (text || (images.length ? 'What do you see in this image?' : csvContext ? 'Please analyze this CSV data.' : channelJsonData ? 'I have loaded YouTube channel data. You can use your tools to plot metrics vs time, play videos, compute stats, or generate images.' : ''));

    const userMsg = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: userContent,
      timestamp: new Date().toISOString(),
      images: [...images],
      csvName: capturedCsv?.name || null,
    };

    setMessages((m) => [...m, userMsg]);
    setInput('');
    const capturedImages = [...images];
    setImages([]);
    setCsvContext(null);
    setStreaming(true);
    try {
      // Store display text only — base64 is never persisted
      await saveMessage(sessionId, 'user', userContent, capturedImages.length ? capturedImages : null);

      const assistantId = `a-${Date.now()}`;
      setMessages((m) => [
        ...m,
        { id: assistantId, role: 'model', content: useImageTools ? 'Generating image…' : '', timestamp: new Date().toISOString() },
      ]);

      abortRef.current = false;

      let fullContent = '';
      let groundingData = null;
      let structuredParts = null;
      let toolCharts = [];
      let toolCalls = [];

      // HARD ROUTE: image requests never enter Gemini tool-calling/chat pipelines.
      if (useImageTools) {
        const anchorImage = capturedImages[0];
        const hasAnchor = typeof anchorImage?.data === 'string' && anchorImage.data.trim().length > 0;
        const imageRequestPayload = {
          prompt: text || 'Generate an image.',
          ...(hasAnchor
            ? {
                anchorImageBase64: anchorImage.data,
                anchorMimeType: anchorImage.mimeType,
              }
            : {}),
        };
        const result = await withTimeout(
          apiGenerateImage(imageRequestPayload),
          90000
        );
        fullContent = 'Here you go.';
        toolCharts = [{
          _chartType: 'generatedImage',
          imageBase64: result.imageBase64,
          mimeType: result.mimeType || 'image/png',
        }];
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  content: fullContent,
                  charts: toolCharts,
                }
              : msg
          )
        );
        await saveMessage(
          sessionId,
          'model',
          fullContent,
          null,
          toolCharts.length ? toolCharts : null,
          null
        );
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, messageCount: s.messageCount + 2 } : s))
        );
        inputRef.current?.focus();
        return;
      } else if (useYouTubeTools) {
        // History: plain display text only — session summary handles CSV context on every message
        const history = messages
          .filter((m) => m.role === 'user' || m.role === 'model')
          .map((m) => ({ role: m.role, content: m.content || messageText(m) }));
        const anchorImage = capturedImages[0];
        const youtubeContext = {
          videos,
          anchorImageBase64: anchorImage?.data || null,
          anchorMimeType: anchorImage?.mimeType || 'image/png',
        };
        const { text: answer, charts: returnedCharts, toolCalls: returnedCalls } = await chatWithYouTubeTools(
          history,
          promptForGemini,
          (toolName, args) => executeYouTubeTool(toolName, args, youtubeContext)
        );
        fullContent = answer;
        toolCharts = returnedCharts || [];
        toolCalls = returnedCalls || [];
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  content: fullContent,
                  charts: toolCharts.length ? toolCharts : undefined,
                  toolCalls: toolCalls.length ? toolCalls : undefined,
                }
              : msg
          )
        );
      } else if (useTools) {
        const history = messages
          .filter((m) => m.role === 'user' || m.role === 'model')
          .map((m) => ({ role: m.role, content: m.content || messageText(m) }));
        console.log('[Chat] useTools=true | rows:', sessionCsvRows.length, '| headers:', sessionCsvHeaders);
        const { text: answer, charts: returnedCharts, toolCalls: returnedCalls } = await chatWithCsvTools(
          history,
          promptForGemini,
          sessionCsvHeaders,
          (toolName, args) => executeTool(toolName, args, sessionCsvRows)
        );
        fullContent = answer;
        toolCharts = returnedCharts || [];
        toolCalls = returnedCalls || [];
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  content: fullContent,
                  charts: toolCharts.length ? toolCharts : undefined,
                  toolCalls: toolCalls.length ? toolCalls : undefined,
                }
              : msg
          )
        );
      } else {
        const imageParts = capturedImages.map((img) => ({ mimeType: img.mimeType, data: img.data }));
        const history = messages
          .filter((m) => m.role === 'user' || m.role === 'model')
          .map((m) => ({ role: m.role, content: m.content || messageText(m) }));
        // ── Streaming path: plain text + search grounding (no code execution) ─
        for await (const chunk of streamChat(history, promptForGemini, imageParts)) {
          if (abortRef.current) break;
          if (chunk.type === 'text') {
            fullContent += chunk.text;
            const contentSnapshot = fullContent;
            setMessages((m) =>
              m.map((msg) => (msg.id === assistantId ? { ...msg, content: contentSnapshot } : msg))
            );
          } else if (chunk.type === 'fullResponse') {
            structuredParts = chunk.parts;
            const partsSnapshot = structuredParts;
            setMessages((m) =>
              m.map((msg) =>
                msg.id === assistantId ? { ...msg, content: '', parts: partsSnapshot } : msg
              )
            );
          } else if (chunk.type === 'grounding') {
            groundingData = chunk.data;
          }
        }
      }

      if (groundingData) {
        setMessages((m) =>
          m.map((msg) => (msg.id === assistantId ? { ...msg, grounding: groundingData } : msg))
        );
      }

      // Save plain text + any tool charts to DB
      const savedContent = structuredParts
        ? structuredParts.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
        : fullContent;
      await saveMessage(
        sessionId,
        'model',
        savedContent,
        null,
        toolCharts.length ? toolCharts : null,
        toolCalls.length ? toolCalls : null
      );

      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, messageCount: s.messageCount + 2 } : s))
      );
      inputRef.current?.focus();
    } catch (err) {
      const errText = useImageTools ? `Image generation failed: ${err.message}` : `Error: ${err.message}`;
      setMessages((m) => {
        const copy = [...m];
        const idx = [...copy].reverse().findIndex((msg) => msg.role === 'model');
        if (idx >= 0) {
          const realIdx = copy.length - 1 - idx;
          copy[realIdx] = { ...copy[realIdx], content: errText };
        }
        return copy;
      });
    } finally {
      setStreaming(false);
    }
  };

  const removeImage = (i) => setImages((prev) => prev.filter((_, idx) => idx !== i));

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  const formatDate = (dateStr) => {
    const d = new Date(dateStr);
    const diffDays = Math.floor((Date.now() - d) / 86400000);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 0) return `Today · ${time}`;
    if (diffDays === 1) return `Yesterday · ${time}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${time}`;
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="chat-layout">
      {/* ── Sidebar ──────────────────────────────── */}
      <aside className="chat-sidebar">
        <div className="sidebar-top">
          <h1 className="sidebar-title">Chat</h1>
          <button className="new-chat-btn" onClick={handleNewChat}>
            + New Chat
          </button>
        </div>

        <div className="sidebar-sessions">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`sidebar-session${session.id === activeSessionId ? ' active' : ''}`}
              onClick={() => handleSelectSession(session.id)}
            >
              <div className="sidebar-session-info">
                <span className="sidebar-session-title">{session.title}</span>
                <span className="sidebar-session-date">{formatDate(session.createdAt)}</span>
              </div>
              <div
                className="sidebar-session-menu"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenuId(openMenuId === session.id ? null : session.id);
                }}
              >
                <span className="three-dots">⋮</span>
                {openMenuId === session.id && (
                  <div className="session-dropdown">
                    <button
                      className="session-delete-btn"
                      onClick={(e) => handleDeleteSession(session.id, e)}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          <span className="sidebar-username">{username}</span>
          <button onClick={onLogout} className="sidebar-logout">
            Log out
          </button>
        </div>
      </aside>

      {/* ── Main chat area ───────────────────────── */}
      <div className="chat-main">
        <>
        <header className="chat-header">
          <h2 className="chat-header-title">{activeSession?.title ?? 'New Chat'}</h2>
        </header>

        <div
          className={`chat-messages${dragOver ? ' drag-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          {messages.map((m) => (
            <div key={m.id} className={`chat-msg ${m.role}`}>
              <div className="chat-msg-meta">
                <span className="chat-msg-role">{m.role === 'user' ? username : 'Lisa'}</span>
                <span className="chat-msg-time">
                  {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>

              {/* CSV badge on user messages */}
              {m.csvName && (
                <div className="msg-csv-badge">
                  📄 {m.csvName}
                </div>
              )}

              {/* Image attachments */}
              {m.images?.length > 0 && (
                <div className="chat-msg-images">
                  {m.images.map((img, i) => (
                    <img key={i} src={`data:${img.mimeType};base64,${img.data}`} alt="" className="chat-msg-thumb" />
                  ))}
                </div>
              )}

              {/* Message body */}
              <div className="chat-msg-content">
                {m.role === 'model' ? (
                  m.parts ? (
                    <StructuredParts parts={m.parts} />
                  ) : m.content ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  ) : (
                    <span className="thinking-dots">
                      <span /><span /><span />
                    </span>
                  )
                ) : (
                  m.content
                )}
              </div>

              {/* Tool error (e.g. generateImage failed) — show so user sees real message */}
              {m.toolCalls?.some((tc) => tc.result?.error) && (
                <div className="chat-tool-error">
                  <strong>Tool error:</strong>{' '}
                  {m.toolCalls.find((tc) => tc.result?.error)?.result?.error || 'Something went wrong.'}
                </div>
              )}

              {/* Tool calls log */}
              {m.toolCalls?.length > 0 && (
                <details className="tool-calls-details">
                  <summary className="tool-calls-summary">
                    🔧 {m.toolCalls.length} tool{m.toolCalls.length > 1 ? 's' : ''} used
                  </summary>
                  <div className="tool-calls-list">
                    {m.toolCalls.map((tc, i) => (
                      <div key={i} className="tool-call-item">
                        <span className="tool-call-name">{tc.name}</span>
                        <span className="tool-call-args">{JSON.stringify(tc.args)}</span>
                        {tc.result?.error && (
                          <span className="tool-call-result tool-call-error">→ {tc.result.error}</span>
                        )}
                        {tc.result && !tc.result._chartType && !tc.result.error && (
                          <span className="tool-call-result">
                            → {JSON.stringify(tc.result).slice(0, 200)}
                            {JSON.stringify(tc.result).length > 200 ? '…' : ''}
                          </span>
                        )}
                        {tc.result?._chartType && (
                          <span className="tool-call-result">→ rendered chart</span>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {/* Engagement charts from tool calls */}
              {m.charts?.map((chart, ci) =>
                chart._chartType === 'engagement' ? (
                  <EngagementChart
                    key={ci}
                    data={chart.data}
                    metricColumn={chart.metricColumn}
                  />
                ) : chart._chartType === 'metricVsTime' ? (
                  <MetricVsTimeChart
                    key={ci}
                    data={chart.data}
                    metricField={chart.metricField}
                  />
                ) : chart._chartType === 'playVideo' ? (
                  <PlayVideoCard
                    key={ci}
                    title={chart.title}
                    thumbnail={chart.thumbnail}
                    videoUrl={chart.videoUrl}
                  />
                ) : chart._chartType === 'generatedImage' ? (
                  <GeneratedImage
                    key={ci}
                    imageBase64={chart.imageBase64}
                    mimeType={chart.mimeType}
                  />
                ) : chart._chartType === 'statsJson' ? (
                  <StatsJsonCard key={ci} stats={chart} />
                ) : null
              )}

              {/* Search sources */}
              {m.grounding?.groundingChunks?.length > 0 && (
                <div className="chat-msg-sources">
                  <span className="sources-label">Sources</span>
                  <div className="sources-list">
                    {m.grounding.groundingChunks.map((chunk, i) =>
                      chunk.web ? (
                        <a key={i} href={chunk.web.uri} target="_blank" rel="noreferrer" className="source-link">
                          {chunk.web.title || chunk.web.uri}
                        </a>
                      ) : null
                    )}
                  </div>
                  {m.grounding.webSearchQueries?.length > 0 && (
                    <div className="sources-queries">
                      Searched: {m.grounding.webSearchQueries.join(' · ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {dragOver && <div className="chat-drop-overlay">Drop CSV, JSON, or images here</div>}

        {/* ── Input area ── */}
        <div className="chat-input-area">
          {/* Channel JSON chip */}
          {channelJsonData && (
            <div className="csv-chip">
              <span className="csv-chip-icon">📺</span>
              <span className="csv-chip-name">{channelJsonFileName || 'Channel JSON'}</span>
              <span className="csv-chip-meta">
                {channelJsonData.videos?.length ?? 0} videos
              </span>
              <button className="csv-chip-remove" onClick={() => { setChannelJsonData(null); setChannelJsonFileName(null); setChannelLoadNotice(''); localStorage.removeItem('youtube_channel_data'); }} aria-label="Remove JSON">×</button>
            </div>
          )}
          {channelLoadNotice && (
            <div className="csv-chip" role="status">
              <span className="csv-chip-icon">ℹ️</span>
              <span className="csv-chip-name">{channelLoadNotice}</span>
            </div>
          )}
          {/* CSV chip */}
          {csvContext && (
            <div className="csv-chip">
              <span className="csv-chip-icon">📄</span>
              <span className="csv-chip-name">{csvContext.name}</span>
              <span className="csv-chip-meta">
                {csvContext.rowCount} rows · {csvContext.headers.length} cols
              </span>
              <button className="csv-chip-remove" onClick={() => setCsvContext(null)} aria-label="Remove CSV">×</button>
            </div>
          )}

          {/* Image previews */}
          {images.length > 0 && (
            <div className="chat-image-previews">
              {images.map((img, i) => (
                <div key={i} className="chat-img-preview">
                  <img src={`data:${img.mimeType};base64,${img.data}`} alt="" />
                  <button type="button" onClick={() => removeImage(i)} aria-label="Remove">×</button>
                </div>
              ))}
            </div>
          )}

          {/* Hidden file picker */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.csv,text/csv,.json,application/json"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />

          <div className="chat-input-row">
            <button
              type="button"
              className="attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={streaming}
              title="Attach image or CSV"
            >
              📎
            </button>
            <input
              ref={inputRef}
              type="text"
              placeholder="Ask a question, request analysis, or write & run code…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
              onPaste={handlePaste}
              disabled={streaming}
            />
            {streaming ? (
              <button onClick={handleStop} className="stop-btn">
                ■ Stop
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim() && !images.length && !csvContext && !channelJsonData}
              >
                Send
              </button>
            )}
          </div>
        </div>
        </>
      </div>
    </div>
  );
}
