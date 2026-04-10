interface ProgressBarProps {
  value: number;
  max: number;
  color?: string;
  label?: string;
}

export default function ProgressBar({ value, max, color = '#1B5E20', label }: ProgressBarProps) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="progress-bar-container">
      {label && <div className="progress-label">{label}</div>}
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <div className="progress-text">{pct.toFixed(0)}%</div>
    </div>
  );
}
