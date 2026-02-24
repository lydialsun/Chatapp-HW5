import { useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import './MetricVsTimeChart.css';

export default function MetricVsTimeChart({ data, metricField }) {
  const [enlarged, setEnlarged] = useState(false);

  if (!data?.length) return null;

  const handleDownload = () => {
    const csv = ['date,value,title', ...data.map((d) => `"${d.date}",${d.value},"${(d.title || '').replace(/"/g, '""')}"`)].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `metric_vs_time_${metricField}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const content = (
    <>
      <div className="metric-vs-time-header">
        <span>{metricField} vs time</span>
        <div className="metric-vs-time-actions">
          <button type="button" onClick={handleDownload}>Download CSV</button>
          <button type="button" onClick={() => setEnlarged((e) => !e)}>{enlarged ? 'Shrink' : 'Enlarge'}</button>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={enlarged ? 400 : 260}>
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 24 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(156, 175, 136, 0.2)" />
          <XAxis dataKey="date" tick={{ fontSize: 10 }} angle={-30} textAnchor="end" interval={0} />
          <YAxis tick={{ fontSize: 10 }} />
          <Tooltip />
          <Line type="monotone" dataKey="value" stroke="#9caf88" strokeWidth={2} dot={{ r: 3 }} name={metricField} />
        </LineChart>
      </ResponsiveContainer>
    </>
  );

  if (enlarged) {
    return (
      <div className="metric-vs-time-enlarged" onClick={() => setEnlarged(false)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Escape' && setEnlarged(false)}>
        <div className="metric-vs-time-enlarged-inner" onClick={(e) => e.stopPropagation()}>
          {content}
        </div>
      </div>
    );
  }

  return <div className="metric-vs-time-wrap">{content}</div>;
}
