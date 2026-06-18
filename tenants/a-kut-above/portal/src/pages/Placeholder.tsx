type Props = {
  title: string;
  icon: string;
  description: string;
  note?: string;
};

/**
 * Honest empty-state page for Command Center sections that exist in the nav
 * but have no real data yet. Shows a real "0" rather than fabricated records.
 */
export default function Placeholder({ title, icon, description, note }: Props) {
  return (
    <div>
      <div className="page-header">
        <div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <div className="stat-card" style={{ minWidth: 140 }}>
          <span className="stat-title">Total</span>
          <span className="stat-value">0</span>
        </div>
      </div>
      <div className="card empty-state">
        <div className="empty-icon">{icon}</div>
        <h3>No {title.toLowerCase()} yet</h3>
        <p className="text-muted" style={{ maxWidth: 440, margin: '0 auto' }}>
          {note || 'This section activates automatically as records come in.'}
        </p>
      </div>
    </div>
  );
}
