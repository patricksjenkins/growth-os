import { formatCurrency } from '../utils';

interface StatCardProps {
  title: string;
  value: number;
  color?: string;
  prefix?: string;
}

export default function StatCard({ title, value, color = '#1B5E20', prefix = '$' }: StatCardProps) {
  return (
    <div className="stat-card">
      <div className="stat-title">{title}</div>
      <div className="stat-value" style={{ color }}>
        {prefix === '$' ? formatCurrency(value) : `${prefix}${value}`}
      </div>
    </div>
  );
}
