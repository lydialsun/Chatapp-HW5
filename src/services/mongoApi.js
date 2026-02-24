const API_BASE = (process.env.REACT_APP_API_BASE_URL || process.env.REACT_APP_API_URL || '').replace(/\/+$/, '');

function buildApiUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  const base = API_BASE || '';
  const combined = base ? `${base}${p}` : p;
  return combined.replace(/(?<!:)\/\/+/g, '/');
}

const api = async (path, options = {}) => {
  const url = buildApiUrl(path);
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text || res.statusText;
    let code;
    try {
      const json = JSON.parse(text);
      if (json.error) message = typeof json.error === 'string' ? json.error : (json.error.message || JSON.stringify(json.error));
      code = json.code;
    } catch (_) {}
    const err = new Error(message);
    err.status = res.status;
    err.body = text;
    err.code = code;
    throw err;
  }
  return text ? JSON.parse(text) : {};
};

// ── Users ────────────────────────────────────────────────────────────────────

export const createUser = async (username, password, email = '', firstName = '', lastName = '') => {
  await api('/api/users', {
    method: 'POST',
    body: JSON.stringify({ username, password, email, firstName, lastName }),
  });
};

export const findUser = async (username, password) => {
  const data = await api('/api/users/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  if (!data.ok) return null;
  return {
    _id: data._id || null,
    username: data.username,
    firstName: data.firstName || null,
    lastName: data.lastName || null,
  };
};

// ── Sessions ─────────────────────────────────────────────────────────────────

export const getSessions = async (username) => {
  return api(`/api/sessions?username=${encodeURIComponent(username)}`);
};

export const createSession = async (username, agent = null, title = null) => {
  return api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ username, agent, title }),
  });
};

export const deleteSession = async (sessionId) => {
  return api(`/api/sessions/${sessionId}`, { method: 'DELETE' });
};

export const updateSessionTitle = async (sessionId, title) => {
  return api(`/api/sessions/${sessionId}/title`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
};

// ── Messages ─────────────────────────────────────────────────────────────────

export const saveMessage = async (sessionId, role, content, imageData = null, charts = null, toolCalls = null) => {
  return api('/api/messages', {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId, role, content, imageData, charts, toolCalls }),
  });
};

export const loadMessages = async (sessionId) => {
  return api(`/api/messages?session_id=${encodeURIComponent(sessionId)}`);
};

// ── YouTube ─────────────────────────────────────────────────────────────────

/** Fetch channel video metadata via backend scraper (no API key). */
export const fetchYouTubeChannelViaGemini = async (channelUrl, maxVideos = 10) => {
  return api('/api/youtube/download-channel', {
    method: 'POST',
    body: JSON.stringify({ channelUrl, maxVideos }),
  });
};

// ── Image generation ────────────────────────────────────────────────────────

export const generateImage = async (prompt, anchorImageBase64 = null, anchorMimeType = 'image/png') => {
  const controller = new AbortController();
  const timeoutMs = 70000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/api/tools/generateImage`.replace(/(?<!:)\/\/+/g, '/'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, anchorImageBase64, anchorMimeType }),
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error('Invalid JSON from server');
    }
    if (!res.ok) {
      throw new Error(data?.error || 'Image generation failed');
    }
    if (!data?.imageBase64) {
      throw new Error('Image generation failed: no image in response');
    }
    return {
      imageBase64: data?.imageBase64,
      mimeType: data?.mimeType || 'image/png',
    };
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`Image generation request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
};
