export function normalizeReleaseDate(raw, now = new Date()) {
  if (!raw || typeof raw !== 'string') return { iso: null, ms: null };

  const original = raw.trim();
  if (!original) return { iso: null, ms: null };

  const s = original
    .toLowerCase()
    .replace(/^streamed\s+/, '')
    .replace(/^premiered\s+/, '')
    .replace(/^uploaded\s+/, '')
    .trim();

  const parsed = Date.parse(s);
  if (Number.isFinite(parsed)) {
    return { iso: new Date(parsed).toISOString(), ms: parsed };
  }

  const m = s.match(/^(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago$/);
  if (!m) return { iso: null, ms: null };

  const n = parseInt(m[1], 10);
  const unit = m[2];
  const d = new Date(now);

  if (unit === 'minute') d.setMinutes(d.getMinutes() - n);
  if (unit === 'hour') d.setHours(d.getHours() - n);
  if (unit === 'day') d.setDate(d.getDate() - n);
  if (unit === 'week') d.setDate(d.getDate() - n * 7);
  if (unit === 'month') d.setMonth(d.getMonth() - n);
  if (unit === 'year') d.setFullYear(d.getFullYear() - n);

  return { iso: d.toISOString(), ms: d.getTime() };
}

function getRawDateWithSource(video) {
  if (video?.release_date != null) return { raw: video.release_date, source: 'release_date' };
  if (video?.publishedAt != null) return { raw: video.publishedAt, source: 'publishedAt' };
  if (video?.publishDate != null) return { raw: video.publishDate, source: 'publishDate' };
  if (video?.uploadDate != null) return { raw: video.uploadDate, source: 'uploadDate' };
  if (video?.relative_published != null) return { raw: video.relative_published, source: 'relative_published' };
  if (video?.published_at != null) return { raw: video.published_at, source: 'published_at' };
  if (video?.releaseDate != null) return { raw: video.releaseDate, source: 'releaseDate' };
  return { raw: null, source: null };
}

export function normalizeVideosReleaseDates(videos, now = new Date()) {
  if (!Array.isArray(videos)) return { videos: [], normalizedCount: 0, invalidCount: 0 };
  let normalizedCount = 0;
  let invalidCount = 0;
  const next = videos.map((v) => {
    const { raw, source } = getRawDateWithSource(v);
    const normalized = normalizeReleaseDate(raw, now);
    const iso = normalized.iso;
    const ms = normalized.ms;

    if (iso && Number.isFinite(ms)) normalizedCount++;
    else invalidCount++;
    return {
      ...v,
      release_date_raw: raw ?? null,
      release_date_source: source,
      release_date_iso: iso,
      release_date_ms: ms,
    };
  });
  return { videos: next, normalizedCount, invalidCount };
}

