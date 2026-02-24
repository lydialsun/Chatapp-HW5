import { useState } from 'react';
import { fetchYouTubeChannel } from '../services/mongoApi';
import './YouTubeChannelDownload.css';

export default function YouTubeChannelDownload() {
  const [channelUrl, setChannelUrl] = useState('https://www.youtube.com/@veritasium');
  const [maxVideos, setMaxVideos] = useState(10);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const SAMPLE_JSON_URL = '/veritasium_channel_data.json';

  const handleDownload = async () => {
    setError('');
    setResult(null);
    setLoading(true);
    setProgress(10);
    try {
      setProgress(30);
      const data = await fetchYouTubeChannel(channelUrl, Math.min(100, Math.max(1, maxVideos)));
      setProgress(90);
      setResult(data);
      setProgress(100);
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('YouTube API key not configured') || msg.includes('YOUTUBE_API_KEY')) {
        try {
          setProgress(50);
          const res = await fetch(SAMPLE_JSON_URL);
          if (!res.ok) throw new Error('Sample not found');
          const sample = await res.json();
          setResult({ ...sample, _sampleFallback: true });
          setError('');
        } catch (sampleErr) {
          setError('YouTube API key is not configured on the server. Add YOUTUBE_API_KEY in your backend environment (e.g. Render). Sample data could not be loaded.');
          setResult(null);
        }
      } else {
        setError(msg || 'Download failed');
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
        <p className="youtube-download-desc">Enter a YouTube channel URL to download video metadata (title, description, duration, view count, like count, comment count, video URL).</p>

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
          </div>
        )}

        {error && <p className="youtube-download-error">{error}</p>}

        {result && !loading && (
          <div className="youtube-result">
            {result._sampleFallback && (
              <p className="youtube-sample-notice">YouTube API key not set on server; showing sample Veritasium data. You can still use this in Chat or download it.</p>
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
