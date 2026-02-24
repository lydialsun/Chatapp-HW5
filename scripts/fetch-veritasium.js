#!/usr/bin/env node
/**
 * Fetches videos from https://www.youtube.com/@veritasium and writes
 * veritasium_10.json to the public folder using the no-API-key scraper.
 *
 * Usage: node scripts/fetch-veritasium.js [maxVideos]
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const fs = require('fs');
const { scrapeYouTubeChannelData } = require('../server/youtubeScrape');
const VERITASIUM_URL = 'https://www.youtube.com/@veritasium';
const MAX_VIDEOS = Math.min(100, Math.max(1, parseInt(process.argv[2] || '10', 10)));

async function main() {
  const data = await scrapeYouTubeChannelData(VERITASIUM_URL, MAX_VIDEOS);
  const publicDir = path.resolve(__dirname, '..', 'public');
  const outPath = path.join(publicDir, 'veritasium_channel_data.json');
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
  const likeNonNull = (data.videos || []).filter((v) => v.likeCount !== null && v.likeCount !== undefined).length;
  const commentNonNull = (data.videos || []).filter((v) => v.commentCount !== null && v.commentCount !== undefined).length;
  const releaseNonNull = (data.videos || []).filter((v) => !!v.releaseDate).length;
  console.log('Wrote', outPath, 'with', data.videos.length, 'videos');
  console.log(`Non-null counts: releaseDate=${releaseNonNull}, likeCount=${likeNonNull}, commentCount=${commentNonNull}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
