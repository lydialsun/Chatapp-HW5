const API_BASE = (process.env.REACT_APP_API_URL || '').replace(/\/+$/, '');

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
  if (!res.ok) throw new Error(text || res.statusText);
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

export const fetchYouTubeChannel = async (channelUrl, maxVideos = 10) => {
  return api(`/api/youtube/channel?url=${encodeURIComponent(channelUrl)}&maxVideos=${maxVideos}`);
};

// ── Image generation ────────────────────────────────────────────────────────

export const generateImage = async (prompt, anchorImageBase64 = null, anchorMimeType = 'image/png') => {
  return api('/api/generate-image', {
    method: 'POST',
    body: JSON.stringify({ prompt, anchorImageBase64, anchorMimeType }),
  });
};
