/**
 * Chat tools for YouTube channel JSON data.
 * Required names: generateImage, plot_metric_vs_time, play_video, compute_stats_json
 */

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
        metricField: {
          type: 'STRING',
          description: 'Exact field name from the channel JSON, e.g. viewCount, likeCount, commentCount, durationSeconds.',
        },
      },
      required: ['metricField'],
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
        which: {
          type: 'STRING',
          description: 'How to select the video: "first", "last", "most viewed", "least viewed", or the exact video title (or a substring that matches one video).',
        },
      },
      required: ['which'],
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
      const field = resolveNumericField(videos, args.metricField || 'viewCount');
      const withDate = videos
        .map((v) => {
          const date = v.releaseDate || v.publishedAt || v.published;
          const num = typeof v[field] === 'number' ? v[field] : parseFloat(v[field]);
          if (!date || isNaN(num)) return null;
          return { date: new Date(date).toISOString().slice(0, 10), value: num, title: v.title };
        })
        .filter(Boolean)
        .sort((a, b) => a.date.localeCompare(b.date));
      if (!withDate.length) return { error: `No valid data for field "${field}" with dates. Available: ${Object.keys(videos[0] || {}).join(', ')}` };
      return { _chartType: 'metricVsTime', data: withDate, metricField: field };
    }

    case 'play_video': {
      const which = (args.which || '').toLowerCase().trim();
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
      const videoUrl = v.videoUrl || (v.videoId ? `https://www.youtube.com/watch?v=${v.videoId}` : '');
      return {
        _chartType: 'playVideo',
        title: v.title || 'Video',
        thumbnail: v.thumbnail || (v.videoId ? `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg` : null),
        videoUrl,
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
