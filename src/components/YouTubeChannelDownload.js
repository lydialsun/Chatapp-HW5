import { useState, useRef } from 'react';
import { fetchYouTubeChannelViaGemini } from '../services/mongoApi';
import './YouTubeChannelDownload.css';

const SAMPLE_JSON_URL = '/veritasium_channel_data.json';

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
      doneRef.current = true;
      clear();
      setProgress(100);
      setResult(data);
    } catch (err) {
      doneRef.current = true;
      clear();
      const msg = (err.message || '').toLowerCase();
      const isGeminiError = msg.includes('gemini') || msg.includes('not configured') || msg.includes('503');
      try {
        const res = await fetch(SAMPLE_JSON_URL);
        if (!res.ok) throw new Error('Sample not found');
        const sample = await res.json();
        setResult({ ...sample, _sampleFallback: true });
        setError('');
      } catch (sampleErr) {
        if (isGeminiError) {
          setError('Gemini API key is not set on the server. Add REACT_APP_GEMINI_API_KEY in your backend environment. Sample data could not be loaded.');
        } else {
          setError(err.message || 'Download failed');
        }
        setResult(null);
      }
    } finally {
      setLoading(false);
      setProgress(0);
    }
  };

  const handleSaveFile = () => {
    if (!result) return;
    const { _sampleFallback, ...data } = result;
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
          Enter a YouTube channel URL to download video metadata using Gemini and Google Search (no YouTube API key required).
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
            <p className="youtube-progress-label">Fetching metadata via Gemini and Google Search…</p>
          </div>
        )}

        {error && <p className="youtube-download-error">{error}</p>}

        {result && !loading && (
          <div className="youtube-result">
            {result._sampleFallback && (
              <p className="youtube-sample-notice">
                Gemini API key not set on server; showing sample Veritasium data. You can still use this in Chat or download it.
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
