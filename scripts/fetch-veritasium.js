#!/usr/bin/env node
/**
 * Fetches 10 videos from https://www.youtube.com/@veritasium and writes
 * veritasium_channel_data.json to the public folder.
 * Usage: YOUTUBE_API_KEY=your_key node scripts/fetch-veritasium.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.YOUTUBE_API_KEY || process.env.REACT_APP_YOUTUBE_API_KEY;
const base = 'https://www.googleapis.com/youtube/v3';

async function main() {
  if (!API_KEY) {
    console.error('Set YOUTUBE_API_KEY or REACT_APP_YOUTUBE_API_KEY in .env');
    process.exit(1);
  }

  const listRes = await fetch(
    `${base}/channels?part=id,snippet,contentDetails&key=${API_KEY}&forHandle=veritasium`
  );
  const listData = await listRes.json();
  if (!listData.items?.length) {
    console.error('Channel not found');
    process.exit(1);
  }
  const channelId = listData.items[0].id;
  const uploadsId = listData.items[0].contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) {
    console.error('No uploads playlist');
    process.exit(1);
  }

  const plRes = await fetch(
    `${base}/playlistItems?part=snippet,contentDetails&playlistId=${uploadsId}&maxResults=10&key=${API_KEY}`
  );
  const plData = await plRes.json();
  const videoIds = (plData.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean);
  if (videoIds.length === 0) {
    console.error('No videos found');
    process.exit(1);
  }

  const videosRes = await fetch(
    `${base}/videos?part=snippet,contentDetails,statistics&id=${videoIds.join(',')}&key=${API_KEY}`
  );
  const videosData = await videosRes.json();

  const parseDuration = (s) => {
    if (!s || typeof s !== 'string') return null;
    const match = s.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return null;
    const h = parseInt(match[1] || '0', 10);
    const m = parseInt(match[2] || '0', 10);
    const sec = parseInt(match[3] || '0', 10);
    return h * 3600 + m * 60 + sec;
  };

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

  const out = {
    channelId,
    channelTitle: listData.items[0].snippet?.title || 'Veritasium',
    videos,
  };

  const publicDir = path.resolve(__dirname, '..', 'public');
  const outPath = path.join(publicDir, 'veritasium_channel_data.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log('Wrote', outPath, 'with', videos.length, 'videos');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
