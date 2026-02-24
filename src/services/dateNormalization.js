export function normalizeReleaseDate(raw, now = new Date()) {
  if (!raw || typeof raw !== 'string') return { iso: null, ms: null };

  const original = raw.trim();
  if (!original) return { iso: null, ms: null };

  const s = original
    .toLowerCase()
    .replace(/^streamed\s+/, '')
    .replace(/^premiered\s+/, '')
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

export function normalizeVideosReleaseDates(videos, now = new Date()) {
  if (!Array.isArray(videos)) return { videos: [], normalizedCount: 0, invalidCount: 0 };
  let normalizedCount = 0;
  let invalidCount = 0;
  const next = videos.map((v) => {
    const publishedRaw = typeof v.publishedAt === 'string' ? v.publishedAt.trim() : '';
    const releaseRaw = v.release_date ?? v.releaseDate ?? null;

    // Priority:
    // 1) parseable publishedAt
    // 2) release_date absolute/relative
    let iso = null;
    let ms = null;
    if (publishedRaw) {
      const parsedPublished = Date.parse(publishedRaw);
      if (Number.isFinite(parsedPublished)) {
        ms = parsedPublished;
        iso = new Date(parsedPublished).toISOString();
      }
    }
    if (!Number.isFinite(ms)) {
      const normalized = normalizeReleaseDate(releaseRaw, now);
      iso = normalized.iso;
      ms = normalized.ms;
    }

    if (iso && Number.isFinite(ms)) normalizedCount++;
    else invalidCount++;
    return {
      ...v,
      release_date_raw: releaseRaw ?? null,
      release_date_iso: iso,
      release_date_ms: ms,
    };
  });
  return { videos: next, normalizedCount, invalidCount };
}

