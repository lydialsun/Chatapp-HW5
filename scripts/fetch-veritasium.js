#!/usr/bin/env node
/**
 * Fetches videos from https://www.youtube.com/@veritasium and writes
 * veritasium_channel_data.json to the public folder.
 * Uses the same logic as fetch-channel.js and the API (server/youtubeChannel.js).
 *
 * Usage: YOUTUBE_API_KEY=your_key node scripts/fetch-veritasium.js [maxVideos]
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const fs = require('fs');
const { fetchYouTubeChannelData } = require('../server/youtubeChannel');

const API_KEY = process.env.YOUTUBE_API_KEY || process.env.REACT_APP_YOUTUBE_API_KEY;
const VERITASIUM_URL = 'https://www.youtube.com/@veritasium';
const MAX_VIDEOS = Math.min(100, Math.max(1, parseInt(process.argv[2] || '10', 10)));

async function main() {
  if (!API_KEY) {
    console.error('Set YOUTUBE_API_KEY or REACT_APP_YOUTUBE_API_KEY in .env');
    process.exit(1);
  }

  const data = await fetchYouTubeChannelData(VERITASIUM_URL, MAX_VIDEOS, API_KEY);
  const publicDir = path.resolve(__dirname, '..', 'public');
  const outPath = path.join(publicDir, 'veritasium_channel_data.json');
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
  console.log('Wrote', outPath, 'with', data.videos.length, 'videos');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
