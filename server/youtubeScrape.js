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

function parseCount(text) {
  if (!text || typeof text !== 'string') return null;
  const digits = text.replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

function normalizeIsoDate(input) {
  if (!input || typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;
  // Explicit YYYY-MM-DD handling for stable ISO output
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function getText(node) {
  if (!node) return '';
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r) => r.text || '').join('').trim();
  return '';
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
  const jsonString =
    extractJsonAfterMarker(html, 'var ytInitialPlayerResponse = ') ||
    extractJsonAfterMarker(html, 'window["ytInitialPlayerResponse"] = ') ||
    extractJsonAfterMarker(html, 'ytInitialPlayerResponse = ');
  if (!jsonString) throw new Error(`ytInitialPlayerResponse not found for ${videoId}`);

  let data;
  try {
    data = JSON.parse(jsonString);
  } catch {
    throw new Error(`Failed to parse ytInitialPlayerResponse for ${videoId}`);
  }

  const details = data?.videoDetails || {};
  const micro = data?.microformat?.playerMicroformatRenderer || {};
  const durationSeconds = parseInt(details.lengthSeconds || '0', 10);
  const publishRaw = micro.publishDate || micro.uploadDate || null;
  return {
    description: details.shortDescription || '',
    duration: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
    view_count: parseInt(details.viewCount || '0', 10) || null,
    release_date: normalizeIsoDate(publishRaw),
  };
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

  const renderers = [];
  collectVideoRenderers(videosTab, renderers);
  if (!renderers.length) throw new Error('No videos found');

  const top = renderers.slice(0, maxVideos).map((vr) => {
    const thumbs = vr.thumbnail?.thumbnails || [];
    const bestThumb = thumbs[thumbs.length - 1]?.url || thumbs[0]?.url || null;
    return {
      video_id: vr.videoId || '',
      title: getText(vr.title) || '',
      // Never store relative text (e.g. "3 years ago") in release_date.
      release_date: null,
      relative_published: getText(vr.publishedTimeText) || null,
      duration: getText(vr.lengthText) || null,
      view_count: parseCount(getText(vr.viewCountText)),
      thumbnail_url: bestThumb,
    };
  }).filter((v) => v.video_id);

  const videos = [];
  for (const v of top) {
    try {
      const detail = await fetchVideoDetails(v.video_id);
      videos.push({
        video_id: v.video_id,
        title: v.title,
        description: detail.description || '',
        duration: detail.duration ?? v.duration,
        release_date: detail.release_date || null,
        relative_published: v.relative_published || null,
        view_count: detail.view_count ?? v.view_count,
        like_count: null,
        comment_count: null,
        video_url: `https://www.youtube.com/watch?v=${v.video_id}`,
        thumbnail_url: v.thumbnail_url,
        transcript: null,
        transcript_available: false,
      });
    } catch {
      videos.push({
        video_id: v.video_id,
        title: v.title,
        description: '',
        duration: v.duration,
        release_date: null,
        relative_published: v.relative_published || null,
        view_count: v.view_count,
        like_count: null,
        comment_count: null,
        video_url: `https://www.youtube.com/watch?v=${v.video_id}`,
        thumbnail_url: v.thumbnail_url,
        transcript: null,
        transcript_available: false,
      });
    }
  }

  if (!videos.length) throw new Error('No videos found');
  return {
    channel: {
      handle,
      url: channelUrl,
    },
    videos,
  };
}

module.exports = {
  scrapeYouTubeChannelData,
  extractHandle,
};

