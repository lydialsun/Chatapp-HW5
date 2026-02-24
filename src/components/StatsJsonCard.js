export default function StatsJsonCard({ stats }) {
  if (!stats) return null;
  return (
    <div className="stats-json-card">
      <div className="stats-json-title">Statistics: {stats.field}</div>
      <div className="stats-json-grid">
        <div><strong>Count</strong><span>{stats.count}</span></div>
        <div><strong>Mean</strong><span>{stats.mean}</span></div>
        <div><strong>Median</strong><span>{stats.median}</span></div>
        <div><strong>Std</strong><span>{stats.std}</span></div>
        <div><strong>Min</strong><span>{stats.min}</span></div>
        <div><strong>Max</strong><span>{stats.max}</span></div>
      </div>
    </div>
  );
}
