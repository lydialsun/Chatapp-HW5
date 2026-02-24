import { useState } from 'react';
import './GeneratedImage.css';

export default function GeneratedImage({ imageBase64, mimeType = 'image/png' }) {
  const [enlarged, setEnlarged] = useState(false);
  const src = `data:${mimeType};base64,${imageBase64}`;

  const handleDownload = () => {
    const a = document.createElement('a');
    a.href = src;
    a.download = `generated_image_${Date.now()}.png`;
    a.click();
  };

  return (
    <>
      <div className="generated-image-wrap">
        <img
          src={src}
          alt="Generated"
          className="generated-image-img"
          onClick={() => setEnlarged(true)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && setEnlarged(true)}
        />
        <div className="generated-image-actions">
          <button type="button" onClick={handleDownload}>Download</button>
          <button type="button" onClick={() => setEnlarged(true)}>Enlarge</button>
        </div>
      </div>
      {enlarged && (
        <div
          className="generated-image-enlarged"
          onClick={() => setEnlarged(false)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Escape' && setEnlarged(false)}
        >
          <div className="generated-image-enlarged-inner" onClick={(e) => e.stopPropagation()}>
            <img src={src} alt="Generated (enlarged)" />
            <button type="button" onClick={handleDownload}>Download</button>
            <button type="button" onClick={() => setEnlarged(false)}>Close</button>
          </div>
        </div>
      )}
    </>
  );
}
