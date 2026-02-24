const axios = require('axios');

function extractHandle(channelUrl) {
  if (!channelUrl || typeof channelUrl !== 'string') return null;
  const u = channelUrl.trim();
  const handleMatch = u.match(/youtube\.com\/@([^/?&#]+)/i);
  if (handleMatch) return handleMatch[1];
  const rawHandle = u.match(/^@([^/?&#]+)$/);
  if (rawHandle) return rawHandle[1];
  return null;
}

function extractJsonAfterMarker(html, marker) {
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const firstBrace = html.indexOf('{', start);
  if (firstBrace === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = firstBrace; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return html.slice(firstBrace, i + 1);
    }
  }
  return null;
}

function extractJsonByMarkers(html, markers) {
  for (const marker of markers) {
    const json = extractJsonAfterMarker(html, marker);
    if (json) return json;
  }
  return null;
}

function parseCountText(s) {
  if (s === null || s === undefined) return null;
  const text = String(s).trim();
  if (!text) return null;

  const compact = text.toLowerCase().replace(/\s+/g, '');
  const suffixMatch = compact.match(/([\d,.]+)([kmb])\b/);
  if (suffixMatch) {
    const base = Number(suffixMatch[1].replace(/,/g, ''));
    if (!Number.isFinite(base)) return null;
    const mul = suffixMatch[2] === 'k' ? 1e3 : suffixMatch[2] === 'm' ? 1e6 : 1e9;
    return Math.round(base * mul);
  }

  const m = text.match(/([\d,.]+)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseCommentsNumber(s) {
  if (!s) return null;
  const m = String(s).match(/([\d,]+)\s+comments/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeIsoDate(input) {
  if (!input || typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00.000Z`) : new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const midnight = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return midnight.toISOString();
}

function getText(node) {
  if (!node) return '';
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r) => r.text || '').join('').trim();
  return '';
}

function collectStrings(node, out) {
  if (!node) return;
  if (typeof node === 'string') {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, out);
    return;
  }
  if (typeof node !== 'object') return;
  for (const v of Object.values(node)) collectStrings(v, out);
}

function collectAllStrings(obj) {
  const out = [];
  const stack = [obj];
  while (stack.length) {
    const x = stack.pop();
    if (!x) continue;
    if (typeof x === 'string') out.push(x);
    else if (Array.isArray(x)) {
      for (const v of x) stack.push(v);
    } else if (typeof x === 'object') {
      for (const k of Object.keys(x)) stack.push(x[k]);
    }
  }
  return out;
}

function findAllObjectsWithKey(obj, key) {
  const out = [];
  const stack = [obj];
  while (stack.length) {
    const x = stack.pop();
    if (!x) continue;
    if (Array.isArray(x)) {
      for (const v of x) stack.push(v);
      continue;
    }
    if (typeof x !== 'object') continue;
    if (x[key]) out.push(x[key]);
    for (const k of Object.keys(x)) stack.push(x[k]);
  }
  return out;
}

function stringifyAllText(obj) {
  return collectAllStrings(obj);
}

function extractCommentCount(ytInitialData) {
  if (!ytInitialData || typeof ytInitialData !== 'object') {
    return { count: null, source: null };
  }

  function fromTokenNeighbors(strings) {
    const tokens = strings.map((s) => String(s).trim()).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const num = Number(tokens[i].replace(/,/g, ''));
      if (!Number.isFinite(num) || num <= 0) continue;
      const prev = (tokens[i - 1] || '').toLowerCase();
      const next = (tokens[i + 1] || '').toLowerCase();
      if (prev.includes('comment') || next.includes('comment')) return num;
    }
    return null;
  }

  // Strategy A: engagement panels
  const panels = findAllObjectsWithKey(ytInitialData, 'engagementPanelSectionListRenderer');
  for (const p of panels) {
    const txtParts = stringifyAllText(p);
    const txt = txtParts.join(' ');
    const n = parseCommentsNumber(txt);
    if (n !== null) return { count: n, source: 'engagementPanels' };
    const neighbor = fromTokenNeighbors(txtParts);
    if (neighbor !== null) return { count: neighbor, source: 'engagementPanels' };
  }

  // Strategy B: itemSectionRenderer areas
  const candidates = findAllObjectsWithKey(ytInitialData, 'itemSectionRenderer');
  for (const c of candidates) {
    const txtParts = stringifyAllText(c);
    const txt = txtParts.join(' ');
    const n = parseCommentsNumber(txt);
    if (n !== null) return { count: n, source: 'itemSectionRenderer' };
    const neighbor = fromTokenNeighbors(txtParts);
    if (neighbor !== null) return { count: neighbor, source: 'itemSectionRenderer' };
  }

  // Strategy C: recursive fallback strings
  const allStrings = collectAllStrings(ytInitialData);
  for (const s of allStrings) {
    const n = parseCommentsNumber(s);
    if (n !== null) return { count: n, source: 'recursive' };
  }
  const recursiveNeighbor = fromTokenNeighbors(allStrings);
  if (recursiveNeighbor !== null) return { count: recursiveNeighbor, source: 'recursive' };

  return { count: null, source: null };
}

function extractInnertubeConfig(html) {
  const keyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  const clientVersionMatch = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
  return {
    apiKey: keyMatch?.[1] || null,
    clientVersion: clientVersionMatch?.[1] || null,
  };
}

function decodeHtmlEntities(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTranscriptFromXml(xml) {
  if (!xml || typeof xml !== 'string') return null;
  const chunks = [];
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const decoded = decodeHtmlEntities(m[1]).replace(/<[^>]+>/g, '').trim();
    if (decoded) chunks.push(decoded);
  }
  if (!chunks.length) return null;
  return chunks.join(' ').trim();
}

async function fetchTranscriptFromTracks(captionTracks) {
  if (!Array.isArray(captionTracks) || !captionTracks.length) return null;
  const preferred =
    captionTracks.find((t) => String(t.languageCode || '').toLowerCase().startsWith('en')) ||
    captionTracks[0];
  const baseUrl = preferred?.baseUrl;
  if (!baseUrl) return null;
  try {
    const res = await axios.get(baseUrl, { timeout: 15000 });
    const transcript = extractTranscriptFromXml(res.data);
    return transcript && transcript.length ? transcript : null;
  } catch {
    return null;
  }
}

async function fetchCommentCountViaInnertube(html, videoId) {
  const cfg = extractInnertubeConfig(html);
  if (!cfg.apiKey || !cfg.clientVersion) return { count: null, source: null };
  try {
    const url = `https://www.youtube.com/youtubei/v1/next?key=${cfg.apiKey}`;
    const body = {
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: cfg.clientVersion,
          hl: 'en',
          gl: 'US',
        },
      },
      videoId,
    };
    const res = await axios.post(url, body, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
    });
    const found = extractCommentCount(res.data);
    if (found.count !== null) return { count: found.count, source: 'youtubei' };
    const all = collectAllStrings(res.data);
    for (const s of all) {
      const n = parseCommentsNumber(s);
      if (n !== null) return { count: n, source: 'youtubei' };
    }
    return { count: null, source: null };
  } catch {
    return { count: null, source: null };
  }
}

async function fetchPlayerDataViaInnertube(html, videoId) {
  const cfg = extractInnertubeConfig(html);
  if (!cfg.apiKey || !cfg.clientVersion) return null;
  try {
    const url = `https://www.youtube.com/youtubei/v1/player?key=${cfg.apiKey}`;
    const body = {
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: cfg.clientVersion,
          hl: 'en',
          gl: 'US',
        },
      },
      videoId,
    };
    const res = await axios.post(url, body, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
    });
    return res.data || null;
  } catch {
    return null;
  }
}

function collectByKeyPattern(node, keyPattern, out) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) collectByKeyPattern(item, keyPattern, out);
    return;
  }
  if (typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (keyPattern.test(k)) {
      if (typeof v === 'string' || typeof v === 'number') out.push(v);
      else if (v && typeof v === 'object') {
        const txt = getText(v);
        if (txt) out.push(txt);
      }
    }
    collectByKeyPattern(v, keyPattern, out);
  }
}

function collectVideoRenderers(node, acc) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) collectVideoRenderers(item, acc);
    return;
  }
  if (typeof node !== 'object') return;
  if (node.videoRenderer) acc.push(node.videoRenderer);
  for (const value of Object.values(node)) collectVideoRenderers(value, acc);
}

function pickVideosTab(ytInitialData) {
  const tabs = ytInitialData?.contents?.twoColumnBrowseResultsRenderer?.tabs;
  if (!Array.isArray(tabs)) return null;
  return (
    tabs.find((t) => (t.tabRenderer?.title || '').toLowerCase() === 'videos') ||
    tabs.find((t) => (t.tabRenderer?.title || '').toLowerCase().includes('video')) ||
    tabs.find((t) => t.tabRenderer?.selected) ||
    tabs[0] ||
    null
  );
}

function parseDurationTextSeconds(text) {
  if (!text || typeof text !== 'string') return null;
  const parts = text
    .trim()
    .split(':')
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x));
  if (!parts.length) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function extractChannelMeta(ytInitialData, handle) {
  const title =
    ytInitialData?.header?.c4TabbedHeaderRenderer?.title ||
    ytInitialData?.metadata?.channelMetadataRenderer?.title ||
    handle;
  const channelId = ytInitialData?.metadata?.channelMetadataRenderer?.externalId || handle;
  return { channelTitle: title || handle, channelId: channelId || handle };
}

async function fetchHtml(url) {
  const res = await axios.get(url, {
    timeout: 20000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  return res.data;
}

async function fetchVideoDetails(videoId) {
  const html = await fetchHtml(`https://www.youtube.com/watch?v=${videoId}`);
  const playerJsonString = extractJsonByMarkers(html, [
    'var ytInitialPlayerResponse = ',
    'window["ytInitialPlayerResponse"] = ',
    'ytInitialPlayerResponse = ',
  ]);
  if (!playerJsonString) throw new Error(`ytInitialPlayerResponse not found for ${videoId}`);

  const initialDataString = extractJsonByMarkers(html, [
    'var ytInitialData = ',
    'window["ytInitialData"] = ',
    'ytInitialData = ',
  ]);
  if (!initialDataString) {
    console.warn('ytInitialData missing for video', videoId);
  }

  let playerData;
  let initialData = null;
  try {
    playerData = JSON.parse(playerJsonString);
    if (initialDataString) initialData = JSON.parse(initialDataString);
  } catch {
    throw new Error(`Failed to parse watch JSON blobs for ${videoId}`);
  }

  const details = playerData?.videoDetails || {};
  const micro = playerData?.microformat?.playerMicroformatRenderer || {};
  const durationSeconds = Number(details.lengthSeconds);
  const publishRaw = micro.publishDate || micro.uploadDate || null;
  let captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  let transcript = await fetchTranscriptFromTracks(captionTracks);

  // view count: prefer player response, fallback watch-page initial data strings
  let viewCount = parseCountText(details.viewCount);
  if (!Number.isFinite(viewCount) && initialData) {
    const allStrings = [];
    collectStrings(initialData, allStrings);
    const viewLabel = allStrings.find((s) => /views?/i.test(String(s)) && /[\d,.]/.test(String(s)));
    viewCount = parseCountText(viewLabel);
  }

  // like count: gather many candidates and choose largest sensible value
  let likeCount = null;
  const topButtons =
    initialData?.contents?.twoColumnWatchNextResults?.results?.results?.contents
      ?.find((c) => c?.videoPrimaryInfoRenderer)
      ?.videoPrimaryInfoRenderer?.videoActions?.menuRenderer?.topLevelButtons || [];

  const likeStrings = [];
  collectStrings(topButtons, likeStrings);
  const globalStrings = [];
  if (initialData) collectStrings(initialData, globalStrings);
  const likeKeyCandidates = [];
  if (initialData) collectByKeyPattern(initialData, /like/i, likeKeyCandidates);
  const likeCandidates = [
    ...likeStrings.filter((s) => /\blikes?\b/i.test(String(s))),
    ...globalStrings.filter((s) => /\blikes?\b/i.test(String(s))),
    ...likeKeyCandidates,
  ];
  const likeValues = likeCandidates
    .map((s) => parseCountText(s))
    .filter((n) => Number.isFinite(n) && n >= 0);
  likeCount = likeValues.length ? Math.max(...likeValues) : null;

  let comment = initialData ? extractCommentCount(initialData) : { count: null, source: null };
  if (comment.count === null) {
    const htmlCommentFallback =
      parseCommentsNumber(html) ||
      parseCommentsNumber((html.match(/"commentsEntryPointHeaderRenderer"[\s\S]{0,1000}/) || [null])[0]);
    if (htmlCommentFallback !== null) {
      comment = { count: htmlCommentFallback, source: 'html' };
    }
  }
  if (comment.count === null) {
    const viaNext = await fetchCommentCountViaInnertube(html, videoId);
    if (viaNext.count !== null) comment = viaNext;
  }

  let description = details.shortDescription || getText(micro.description) || '';
  if (!description || !description.trim() || !transcript) {
    const playerViaInnertube = await fetchPlayerDataViaInnertube(html, videoId);
    const innerDetails = playerViaInnertube?.videoDetails || {};
    if ((!description || !description.trim()) && innerDetails.shortDescription) {
      description = innerDetails.shortDescription;
    }
    if (!transcript) {
      captionTracks = playerViaInnertube?.captions?.playerCaptionsTracklistRenderer?.captionTracks || captionTracks;
      transcript = await fetchTranscriptFromTracks(captionTracks);
    }
  }

  const releaseIso = normalizeIsoDate(publishRaw);

  return {
    description: description || '',
    transcript,
    duration: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
    viewCount: Number.isFinite(viewCount) ? viewCount : null,
    likeCount: Number.isFinite(likeCount) ? likeCount : null,
    commentCount: Number.isFinite(comment.count) ? comment.count : null,
    commentCountSource: comment.source,
    releaseDate: releaseIso,
  };
}

function backwardInductionDate(relative, now = new Date()) {
  if (!relative || typeof relative !== 'string') return null;
  const s = relative
    .trim()
    .toLowerCase()
    .replace(/^streamed\s+/, '')
    .replace(/^premiered\s+/, '')
    .replace(/^uploaded\s+/, '');
  const m = s.match(/^(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const d = new Date(now);
  if (unit === 'minute') d.setMinutes(d.getMinutes() - n);
  else if (unit === 'hour') d.setHours(d.getHours() - n);
  else if (unit === 'day') d.setDate(d.getDate() - n);
  else if (unit === 'week') d.setDate(d.getDate() - 7 * n);
  else if (unit === 'month') d.setMonth(d.getMonth() - n);
  else if (unit === 'year') d.setFullYear(d.getFullYear() - n);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function scrapeYouTubeChannelData(channelUrl, rawMaxVideos = 10) {
  const handle = extractHandle(channelUrl);
  if (!handle) throw new Error('Invalid YouTube channel URL. Use format: https://www.youtube.com/@handle');

  const maxVideos = Math.min(100, Math.max(1, parseInt(rawMaxVideos || '10', 10)));
  const videosPageUrl = `https://www.youtube.com/@${handle}/videos`;
  const html = await fetchHtml(videosPageUrl);

  const ytInitialDataRaw =
    extractJsonAfterMarker(html, 'var ytInitialData = ') ||
    extractJsonAfterMarker(html, 'window["ytInitialData"] = ') ||
    extractJsonAfterMarker(html, 'ytInitialData = ');
  if (!ytInitialDataRaw) throw new Error('ytInitialData not found');

  let ytInitialData;
  try {
    ytInitialData = JSON.parse(ytInitialDataRaw);
  } catch {
    throw new Error('Failed to parse ytInitialData');
  }

  const videosTab = pickVideosTab(ytInitialData);
  if (!videosTab) throw new Error('Videos tab not found in ytInitialData');
  const channelMeta = extractChannelMeta(ytInitialData, handle);

  const renderers = [];
  collectVideoRenderers(videosTab, renderers);
  if (!renderers.length) throw new Error('No videos found');

  const top = renderers.slice(0, maxVideos).map((vr) => {
    return {
      videoId: vr.videoId || '',
      title: getText(vr.title) || '',
      relativePublished: getText(vr.publishedTimeText) || null,
      durationText: getText(vr.lengthText) || null,
      viewCount: parseCountText(getText(vr.viewCountText)),
    };
  }).filter((v) => v.videoId);

  const videos = [];
  for (const v of top) {
    try {
      const detail = await fetchVideoDetails(v.videoId);
      const induced = !detail.releaseDate ? backwardInductionDate(v.relativePublished) : null;
      const inducedIso = induced ? normalizeIsoDate(induced.toISOString()) : null;
      const finalIso = detail.releaseDate || inducedIso;
      const finalDurationSeconds =
        detail.duration ??
        parseDurationTextSeconds(v.durationText);
      videos.push({
        videoId: v.videoId,
        title: v.title,
        description: detail.description || '',
        transcript: detail.transcript || null,
        duration: Number.isFinite(finalDurationSeconds) ? finalDurationSeconds : 0,
        releaseDate: finalIso,
        viewCount: detail.viewCount ?? v.viewCount ?? 0,
        likeCount: detail.likeCount,
        commentCount: detail.commentCount,
        videoUrl: `https://www.youtube.com/watch?v=${v.videoId}`,
        thumbnail: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      });
      if (detail.commentCount === null) {
        console.warn(`Comment count unavailable for video ${v.videoId}; source=${detail.commentCountSource || 'none'}`);
      }
    } catch (e) {
      console.warn(`watch fetch failed for video ${v.videoId}: ${e?.message || e}`);
      const induced = backwardInductionDate(v.relativePublished);
      const inducedIso = induced ? normalizeIsoDate(induced.toISOString()) : null;
      const fallbackDurationSeconds = parseDurationTextSeconds(v.durationText);
      videos.push({
        videoId: v.videoId,
        title: v.title,
        description: '',
        transcript: null,
        duration: Number.isFinite(fallbackDurationSeconds) ? fallbackDurationSeconds : 0,
        releaseDate: inducedIso,
        viewCount: v.viewCount ?? 0,
        likeCount: null,
        commentCount: null,
        videoUrl: `https://www.youtube.com/watch?v=${v.videoId}`,
        thumbnail: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      });
    }
  }

  if (!videos.length) throw new Error('No videos found');
  return {
    channelId: channelMeta.channelId,
    channelTitle: channelMeta.channelTitle,
    videos,
  };
}

module.exports = {
  scrapeYouTubeChannelData,
  extractHandle,
};

