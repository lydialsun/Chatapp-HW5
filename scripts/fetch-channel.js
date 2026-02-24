#!/usr/bin/env node
/**
 * Fetch any YouTube channel's video list and optionally save to JSON.
 * Uses the same logic as the API (server/youtubeChannel.js) — all video URLs are real.
 *
 * Usage:
 *   YOUTUBE_API_KEY=your_key node scripts/fetch-channel.js <channel_url> [maxVideos] [output_file]
 *
 * Examples:
 *   node scripts/fetch-channel.js "https://www.youtube.com/@veritasium"
 *   node scripts/fetch-channel.js "https://www.youtube.com/@veritasium" 20
 *   node scripts/fetch-channel.js "https://www.youtube.com/@3blue1brown" 10 public/3b1b_channel_data.json
 *
 * If output_file is omitted, writes to public/<slug>_channel_data.json (slug from channel handle or "channel").
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const fs = require('fs');
const { fetchYouTubeChannelData } = require('../server/youtubeChannel');

const API_KEY = process.env.YOUTUBE_API_KEY || process.env.REACT_APP_YOUTUBE_API_KEY;

function slugFromUrl(url) {
  if (!url || typeof url !== 'string') return 'channel';
  const u = url.trim();
  const handle = u.match(/youtube\.com\/@([^/?&#]+)/i);
  if (handle) return handle[1].replace(/\W+/g, '_').slice(0, 32) || 'channel';
  const channel = u.match(/youtube\.com\/channel\/([^/?&#]+)/i);
  if (channel) return channel[1].replace(/\W+/g, '_').slice(0, 32) || 'channel';
  const c = u.match(/youtube\.com\/c\/([^/?&#]+)/i);
  if (c) return c[1].replace(/\W+/g, '_').slice(0, 32) || 'channel';
  return 'channel';
}

async function main() {
  if (!API_KEY) {
    console.error('Set YOUTUBE_API_KEY or REACT_APP_YOUTUBE_API_KEY in .env');
    process.exit(1);
  }

  const channelUrl = process.argv[2];
  if (!channelUrl) {
    console.error('Usage: node scripts/fetch-channel.js <channel_url> [maxVideos] [output_file]');
    console.error('Example: node scripts/fetch-channel.js "https://www.youtube.com/@veritasium" 10');
    process.exit(1);
  }

  const maxVideos = Math.min(
    100,
    Math.max(1, parseInt(process.argv[3] || '10', 10))
  );
  const outputArg = process.argv[4];
  const publicDir = path.resolve(__dirname, '..', 'public');
  const slug = slugFromUrl(channelUrl);
  const defaultFileName = `${slug}_channel_data.json`;
  const outputPath = outputArg
    ? path.isAbsolute(outputArg)
      ? outputArg
      : path.resolve(publicDir, path.basename(outputArg))
    : path.join(publicDir, defaultFileName);

  console.log('Fetching channel:', channelUrl, 'maxVideos:', maxVideos);

  const data = await fetchYouTubeChannelData(channelUrl, maxVideos, API_KEY);

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf8');

  console.log('Wrote', outputPath, 'with', data.videos.length, 'videos');
  console.log('Channel:', data.channelTitle, '| ID:', data.channelId);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
