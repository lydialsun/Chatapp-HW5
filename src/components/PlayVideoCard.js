import './PlayVideoCard.css';

export default function PlayVideoCard({ title, thumbnail, videoUrl }) {
  const openVideo = () => {
    if (videoUrl) window.open(videoUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="play-video-card" onClick={openVideo} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && openVideo()}>
      {thumbnail && <img src={thumbnail} alt="" className="play-video-thumb" />}
      <div className="play-video-info">
        <span className="play-video-title">{title || 'Video'}</span>
        <span className="play-video-hint">Click to open on YouTube ↗</span>
      </div>
    </div>
  );
}
