import { useState, useRef } from 'react';
import { fetchYouTubeChannelViaGemini } from '../services/mongoApi';
import { normalizeVideosReleaseDates } from '../services/dateNormalization';
import './YouTubeChannelDownload.css';

const SAMPLE_JSON_URL = '/veritasium_10.json';

function progressInterval(setProgress, done) {
  const steps = [15, 30, 45, 60, 75, 90];
  let i = 0;
  const id = setInterval(() => {
    if (done.current) return;
    setProgress((p) => (p < 90 ? steps[i] ?? 90 : p));
    i++;
    if (i >= steps.length) clearInterval(id);
  }, 600);
  return () => clearInterval(id);
}

export default function YouTubeChannelDownload() {
  const [channelUrl, setChannelUrl] = useState('https://www.youtube.com/@veritasium');
  const [maxVideos, setMaxVideos] = useState(10);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const doneRef = useRef(false);

  const handleDownload = async () => {
    setError('');
    setResult(null);
    setLoading(true);
    setProgress(10);
    doneRef.current = false;
    const clear = progressInterval(setProgress, doneRef);

    try {
      const max = Math.min(100, Math.max(1, maxVideos));
      const data = await fetchYouTubeChannelViaGemini(channelUrl, max);
      const base = data?.channel
        ? { channelTitle: data.channel.channelTitle || '', videos: data.videos || [] }
        : data;
      const { videos, normalizedCount, invalidCount } = normalizeVideosReleaseDates(base?.videos || []);
      console.warn(`[download-channel] normalized release dates: ok=${normalizedCount}, invalid=${invalidCount}`);
      const normalized = { ...base, videos };
      doneRef.current = true;
      clear();
      setProgress(100);
      setResult(normalized);
    } catch (err) {
      doneRef.current = true;
      clear();
      const serverMessage = err.message || '';
      const isScraperFailure =
        serverMessage.includes('ytInitialData not found') ||
        serverMessage.includes('No videos found') ||
        serverMessage.includes('Invalid YouTube channel URL') ||
        serverMessage.includes('parse');
      try {
        const res = await fetch(SAMPLE_JSON_URL);
        if (!res.ok) throw new Error('Sample not found');
        const sample = await res.json();
        const baseSample = sample?.channel
          ? { channelTitle: sample.channel.channelTitle || '', videos: sample.videos || [] }
          : sample;
        const { videos } = normalizeVideosReleaseDates(baseSample?.videos || []);
        const normalizedSample = { ...baseSample, videos };
        setResult({ ...normalizedSample, _sampleFallback: true, _fallbackReason: isScraperFailure ? 'scrape_failed' : 'other' });
        setError(serverMessage || 'Download failed');
      } catch (sampleErr) {
        setError(serverMessage || 'Download failed');
        setResult(null);
      }
    } finally {
      setLoading(false);
      setProgress(0);
    }
  };

  const handleSaveFile = () => {
    if (!result) return;
    const { _sampleFallback, _fallbackReason, ...data } = result;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `youtube_channel_${(result.channelTitle || 'data').replace(/\W+/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="youtube-download-page">
      <div className="youtube-download-card">
        <h2>YouTube Channel Download</h2>
        <p className="youtube-download-desc">
          Enter a YouTube channel URL to download video metadata using YouTube Data API v3.
          Metadata includes: title, description, transcript (if available), duration, release date, view count, like count, comment count, and video URL.
          Data is saved to a JSON file you can download.
        </p>

        <div className="youtube-download-form">
          <label>
            Channel URL
            <input
              type="url"
              value={channelUrl}
              onChange={(e) => setChannelUrl(e.target.value)}
              placeholder="https://www.youtube.com/@veritasium"
              disabled={loading}
            />
          </label>
          <label>
            Max videos (1–100)
            <input
              type="number"
              min={1}
              max={100}
              value={maxVideos}
              onChange={(e) => setMaxVideos(Number(e.target.value) || 10)}
              disabled={loading}
            />
          </label>
          <button type="button" onClick={handleDownload} disabled={loading}>
            {loading ? 'Downloading…' : 'Download Channel Data'}
          </button>
        </div>

        {loading && (
          <div className="youtube-progress-wrap">
            <div className="youtube-progress-bar">
              <div className="youtube-progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <p className="youtube-progress-label">Fetching metadata via YouTube Data API…</p>
          </div>
        )}

        {error && <p className="youtube-download-error">{error}</p>}

        {result && !loading && (
          <div className="youtube-result">
            {result._sampleFallback && (
              <p className="youtube-sample-notice">
                {result._fallbackReason === 'scrape_failed'
                  ? 'Could not scrape channel data right now; showing sample Veritasium data. You can still use this in Chat or download it.'
                  : 'Download failed; showing sample Veritasium data so you can still use it in Chat or download it.'}
              </p>
            )}
            <p><strong>{result.channelTitle}</strong> — {result.videos?.length ?? 0} videos</p>
            <button type="button" onClick={handleSaveFile} className="youtube-save-btn">
              Download JSON file
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
