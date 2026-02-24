/**
 * Chat tools for YouTube channel JSON data.
 * Required names: generateImage, plot_metric_vs_time, play_video, compute_stats_json
 */

// Fallback real Veritasium video IDs when loaded data has placeholder IDs (sample1, -example, etc.)
const REAL_VERITASIUM_IDS = [
  'NIk_0AW5hFU', 'ZMByI4s-D-Y', 'AeJ9q45PfD0', 'pTn6Ewhb27k', '97t7Xj_iBv0',
  'sWBaMP7UY2k', 'oI_X2cMHNe0', 'rStL7niR7gs', 'BZbChKzedEk', '9z8Fp0d2YjY',
];

function isPlaceholderId(id) {
  if (!id || typeof id !== 'string') return false;
  const s = id.trim();
  return s === '' || /^sample\d*$/i.test(s) || /-example$/i.test(s) || s.includes('-example');
}

function isPlaceholderUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  return u.includes('sample') || u.includes('-example') || u.includes('proxy');
}

export const YOUTUBE_TOOL_DECLARATIONS = [
  {
    name: 'generateImage',
    description:
      'Generate an image from a text prompt and an optional anchor/reference image. ' +
      'Use when the user wants to create an image based on a description and optionally a style or reference image they provided. ' +
      'Returns the generated image for display in the chat.',
    parameters: {
      type: 'OBJECT',
      properties: {
        prompt: {
          type: 'STRING',
          description: 'Detailed text description of the image to generate.',
        },
        useAnchorImage: {
          type: 'BOOLEAN',
          description: 'Whether to use the anchor image the user attached (true) or only the text prompt (false). Default true if user attached an image.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'plot_metric_vs_time',
    description:
      'Plot any numeric field (viewCount, likeCount, commentCount, durationSeconds, etc.) vs time (release date) for the loaded YouTube channel videos. ' +
      'Returns a chart that is displayed in the chat. Use when the user asks to plot, graph, or visualize a metric over time.',
    parameters: {
      type: 'OBJECT',
      properties: {
        metric: {
          type: 'STRING',
          description: 'Exact field name from the channel JSON, e.g. viewCount, likeCount, commentCount, durationSeconds.',
        },
      },
      required: ['metric'],
    },
  },
  {
    name: 'play_video',
    description:
      'Open or play a YouTube video from the loaded channel data. ' +
      'The user can specify the video by: title (e.g. "play the asbestos video"), ordinal (e.g. "play the first video", "play the 3rd video"), or "most viewed". ' +
      'Returns a clickable card with title and thumbnail that opens the video in a new tab.',
    parameters: {
      type: 'OBJECT',
      properties: {
        selectorType: {
          type: 'STRING',
          description: 'How to select a video: "title", "ordinal", or "most_viewed".',
        },
        selectorValue: {
          type: 'STRING',
          description: 'For title: substring of title; for ordinal: 1-based index as string/number; for most_viewed: optional and ignored.',
        },
      },
      required: ['selectorType'],
    },
  },
  {
    name: 'compute_stats_json',
    description:
      'Compute mean, median, std (standard deviation), min, and max for any numeric field in the loaded YouTube channel JSON (e.g. viewCount, likeCount, commentCount, durationSeconds). ' +
      'Use when the user asks for statistics, average, distribution, or summary of a numeric column.',
    parameters: {
      type: 'OBJECT',
      properties: {
        field: {
          type: 'STRING',
          description: 'Exact field name from the channel JSON, e.g. viewCount, likeCount, commentCount, durationSeconds.',
        },
      },
      required: ['field'],
    },
  },
];

function numericValues(videos, field) {
  const key = resolveNumericField(videos, field);
  return videos
    .map((v) => {
      const val = v[key];
      if (typeof val === 'number' && !isNaN(val)) return val;
      if (typeof val === 'string') return parseFloat(val);
      return null;
    })
    .filter((v) => v != null && !isNaN(v));
}

function resolveNumericField(videos, name) {
  if (!videos.length || !name) return name;
  const first = videos[0];
  if (Object.prototype.hasOwnProperty.call(first, name)) return name;
  const lower = name.toLowerCase().replace(/[\s_-]+/g, '');
  const key = Object.keys(first).find((k) => k.toLowerCase().replace(/[\s_-]+/g, '') === lower);
  return key || name;
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Execute a YouTube tool. context: { videos, anchorImageBase64, anchorMimeType, generateImageFn }
 * generateImageFn(prompt, anchorBase64, mimeType) returns Promise<{ imageBase64, mimeType }>
 */
export async function executeYouTubeTool(toolName, args, context) {
  const { videos = [], generateImageFn } = context;

  switch (toolName) {
    case 'generateImage': {
      if (!generateImageFn) return { error: 'Image generation not available' };
      const prompt = args.prompt || '';
      const useAnchor = args.useAnchorImage !== false && context.anchorImageBase64;
      const anchor = useAnchor ? context.anchorImageBase64 : null;
      const mime = context.anchorMimeType || 'image/png';
      try {
        const result = await generateImageFn(prompt, anchor, mime);
        return { _chartType: 'generatedImage', imageBase64: result.imageBase64, mimeType: result.mimeType || 'image/png' };
      } catch (e) {
        return { error: e.message || 'Image generation failed' };
      }
    }

    case 'plot_metric_vs_time': {
      const field = resolveNumericField(videos, args.metric || args.metricField || 'viewCount');
      let skippedInvalidDate = 0;
      let publishedPresent = 0;
      let releaseDatePresent = 0;
      let normalizedMsCount = 0;
      const withDate = videos
        .map((v) => {
          const publishedRaw = typeof v.publishedAt === 'string' ? v.publishedAt.trim() : '';
          const releaseRaw = v.release_date ?? v.releaseDate ?? null;
          if (publishedRaw) publishedPresent++;
          if (releaseRaw) releaseDatePresent++;

          // Requested fallback chain:
          // release_date_ms -> release_date_iso -> publishedAt -> release_date
          const ms =
            (Number.isFinite(v.release_date_ms) ? v.release_date_ms : NaN) ||
            (v.release_date_iso ? Date.parse(v.release_date_iso) : NaN) ||
            (publishedRaw ? Date.parse(publishedRaw) : NaN) ||
            (releaseRaw ? Date.parse(String(releaseRaw)) : NaN);

          const value = Number(v[field]);
          if (!Number.isFinite(ms)) {
            skippedInvalidDate++;
            return null;
          }
          normalizedMsCount++;
          if (!Number.isFinite(value)) return null;
          const d = new Date(ms);
          if (Number.isNaN(d.getTime())) {
            skippedInvalidDate++;
            return null;
          }
          return {
            x: ms,
            ts: ms,
            date: d.toISOString().slice(0, 10),
            value,
            title: v.title,
            video_url: v.video_url || v.videoUrl || '',
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.ts - b.ts)
        .map(({ ts, ...rest }) => rest);
      if (skippedInvalidDate > 0) {
        console.warn(`[plot_metric_vs_time] Skipped ${skippedInvalidDate} videos due to invalid date values.`);
      }
      if (withDate.length < 2) {
        return {
          error: `Not enough valid dates to plot. total=${videos.length}, publishedAt_present=${publishedPresent}, release_date_present=${releaseDatePresent}, normalized_ms=${normalizedMsCount}, invalid_dates=${skippedInvalidDate}. Re-download or normalize dates.`,
        };
      }
      return { _chartType: 'metricVsTime', data: withDate, metricField: field };
    }

    case 'play_video': {
      const selectorType = (args.selectorType || '').toLowerCase().trim();
      const selectorValueRaw = args.selectorValue ?? args.which ?? '';
      const selectorValue = String(selectorValueRaw).toLowerCase().trim();
      const which =
        selectorType === 'most_viewed'
          ? 'most viewed'
          : selectorType === 'ordinal'
            ? selectorValue
            : selectorType === 'title'
              ? selectorValue
              : selectorValue;
      let list = [...videos];
      if (which === 'first' || which === '1st' || which === '1') {
        list = list.slice(0, 1);
      } else if (which === 'last') {
        list = list.slice(-1);
      } else if (which === 'most viewed') {
        list.sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0));
        list = list.slice(0, 1);
      } else if (which === 'least viewed') {
        list.sort((a, b) => (a.viewCount || 0) - (b.viewCount || 0));
        list = list.slice(0, 1);
      } else if (/^\d+(st|nd|rd|th)?$/.test(which)) {
        const n = parseInt(which, 10);
        if (n >= 1 && n <= list.length) list = [list[n - 1]];
        else list = [];
      } else {
        const match = list.find((v) => (v.title || '').toLowerCase().includes(which));
        if (match) list = [match];
        else list = [];
      }
      if (!list.length) return { error: `No video found for "${args.which}"` };
      const v = list[0];
      const originalIndex = videos.indexOf(v);
      const isPlaceholder = isPlaceholderId(v.videoId) || isPlaceholderUrl(v.videoUrl || '');
      const realId = isPlaceholder && originalIndex >= 0 && originalIndex < REAL_VERITASIUM_IDS.length
        ? REAL_VERITASIUM_IDS[originalIndex]
        : (v.videoId && !isPlaceholderId(v.videoId) ? v.videoId : null);
      const videoId = realId || v.videoId;
      const videoUrl = realId
        ? `https://www.youtube.com/watch?v=${realId}`
        : (v.videoUrl && !isPlaceholderUrl(v.videoUrl) ? v.videoUrl : (v.videoId ? `https://www.youtube.com/watch?v=${v.videoId}` : ''));
      const thumbnail = videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : (v.thumbnail || null);
      return {
        _chartType: 'playVideo',
        title: v.title || 'Video',
        thumbnail,
        videoUrl: videoUrl || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : ''),
        viewCount: v.viewCount ?? 0,
        publishedAt: v.releaseDate || v.publishedAt || null,
      };
    }

    case 'compute_stats_json': {
      const field = resolveNumericField(videos, args.field);
      const vals = numericValues(videos, field);
      if (!vals.length) return { error: `No numeric values for field "${field}". Available: ${Object.keys(videos[0] || {}).join(', ')}` };
      const sorted = [...vals].sort((a, b) => a - b);
      const sum = vals.reduce((a, b) => a + b, 0);
      const mean = sum / vals.length;
      const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
      return {
        _chartType: 'statsJson',
        field,
        count: vals.length,
        mean: Math.round(mean * 100) / 100,
        median: median(sorted),
        std: Math.round(Math.sqrt(variance) * 100) / 100,
        min: Math.min(...vals),
        max: Math.max(...vals),
      };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
