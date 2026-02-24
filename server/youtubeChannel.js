/**
 * Shared YouTube channel fetch logic. Used by the API route and by scripts/fetch-channel.js.
 * All video URLs and IDs are real (from YouTube Data API); no placeholders.
 */

const BASE = 'https://www.googleapis.com/youtube/v3';

/**
 * Parse a channel URL or handle into type and value for the API.
 * @param {string} url - e.g. https://www.youtube.com/@veritasium, or @veritasium, or UC...
 * @returns {{ type: 'handle'|'channelId'|'customUrl', value: string } | null}
 */
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

function parseDuration(s) {
  if (!s || typeof s !== 'string') return null;
  const match = s.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;
  const h = parseInt(match[1] || '0', 10);
  const m = parseInt(match[2] || '0', 10);
  const sec = parseInt(match[3] || '0', 10);
  return h * 3600 + m * 60 + sec;
}

/**
 * Fetch channel metadata and recent videos. All returned video IDs and URLs are real.
 * @param {string} channelUrl - Any supported channel URL or handle
 * @param {number} maxVideos - 1–100
 * @param {string} apiKey - YouTube Data API key
 * @returns {Promise<{ channelId: string, channelTitle: string, videos: Array }>}
 */
async function fetchYouTubeChannelData(channelUrl, maxVideos, apiKey) {
  const parsed = parseChannelIdOrHandle(channelUrl);
  if (!parsed) throw new Error('Invalid channel URL. Use e.g. https://www.youtube.com/@veritasium');

  let channelId = null;

  if (parsed.type === 'channelId') {
    channelId = parsed.value;
  } else {
    const query =
      parsed.type === 'handle'
        ? `forHandle=${encodeURIComponent(parsed.value)}`
        : `forUsername=${encodeURIComponent(parsed.value)}`;
    const listRes = await fetch(
      `${BASE}/channels?part=id,snippet,contentDetails&key=${apiKey}&${query}`
    );
    const listData = await listRes.json();
    if (!listData.items?.length) throw new Error('Channel not found');
    channelId = listData.items[0].id;
  }

  const channelRes = await fetch(
    `${BASE}/channels?part=snippet,contentDetails&id=${channelId}&key=${apiKey}`
  );
  const channelData = await channelRes.json();
  const uploadsId = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) throw new Error('Channel has no uploads playlist');

  const playlistRes = await fetch(
    `${BASE}/playlistItems?part=snippet,contentDetails&playlistId=${uploadsId}&maxResults=${maxVideos}&key=${apiKey}`
  );
  const playlistData = await playlistRes.json();
  const videoIds = (playlistData.items || [])
    .map((i) => i.contentDetails?.videoId)
    .filter(Boolean);

  if (videoIds.length === 0) {
    return {
      channelId,
      channelTitle: channelData.items?.[0]?.snippet?.title || '',
      videos: [],
    };
  }

  const videosRes = await fetch(
    `${BASE}/videos?part=snippet,contentDetails,statistics&id=${videoIds.join(',')}&key=${apiKey}`
  );
  const videosData = await videosRes.json();

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

  return {
    channelId,
    channelTitle: channelData.items?.[0]?.snippet?.title || '',
    videos,
  };
}

module.exports = {
  parseChannelIdOrHandle,
  parseDuration,
  fetchYouTubeChannelData,
};
