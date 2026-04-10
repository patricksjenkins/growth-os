import { useState } from 'react';
import { useCustomerInsights, useIncome } from '../hooks/useFinance';
import { formatCurrency, MONTHS } from '../utils';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import type { PieLabelRenderProps } from 'recharts';
import type { IncomeEntry } from '../api/finance';

interface TopCustomer {
  customer_name: string;
  job_count: number;
  total_revenue: number;
}

interface CustomerInsights {
  total_customers: number;
  repeat_customers: number;
  repeat_rate: number;
  repeat_revenue: number;
  new_customer_revenue: number;
  cash_revenue: number;
  cash_job_count: number;
  top_customers: TopCustomer[];
}

/** Check if a customer name is a "Cash" entry */
function isCashEntry(name: string): boolean {
  if (!name) return false;
  const lower = name.toLowerCase().trim();
  return lower === 'cash' || lower.startsWith('cash ') || lower.startsWith('cash(') || lower.includes('(cash)');
}

export default function Customers() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);

  const { data: insightsData, isLoading } = useCustomerInsights(year);
  const { data: monthData, isLoading: loadingMonth } = useIncome(selectedMonth || 1, year);

  const insights: CustomerInsights | null = insightsData?.data || null;

  const totalCustomers = insights?.total_customers ?? 0;
  const repeatCustomers = insights?.repeat_customers ?? 0;
  const repeatRate = insights?.repeat_rate ?? 0;
  const repeatRevenue = insights?.repeat_revenue ?? 0;
  const newCustomerRevenue = insights?.new_customer_revenue ?? 0;
  const cashRevenue = insights?.cash_revenue ?? 0;
  const cashJobCount = insights?.cash_job_count ?? 0;
  const topCustomers: TopCustomer[] = insights?.top_customers ?? [];

  const donutData = [
    { name: 'Repeat', value: repeatRevenue },
    { name: 'New', value: newCustomerRevenue },
    ...(cashRevenue > 0 ? [{ name: 'Cash', value: cashRevenue }] : []),
  ];

  const DONUT_COLORS = ['#1B5E20', '#81C784', '#FFA726'];

  // Compute monthly customer counts from income entries (excluding cash)
  const monthEntries: IncomeEntry[] = monthData?.data || [];
  const realMonthEntries = monthEntries.filter((e) => !isCashEntry(e.customer_name));
  const cashMonthEntries = monthEntries.filter((e) => isCashEntry(e.customer_name));
  const monthCustomerNames = new Set(realMonthEntries.map((e) => e.customer_name));
  const cashMonthTotal = cashMonthEntries.reduce((s, e) => s + e.amount, 0);

  const handleMonthClick = (month: number) => {
    setSelectedMonth(month);
  };

  const handleBack = () => {
    setSelectedMonth(null);
  };

  return (
    <div className="page-customers">
      <div className="page-header">
        <h2>Customers</h2>
        <div className="year-selector">
          <button className="btn-icon" onClick={() => { setYear(year - 1); setSelectedMonth(null); }}>&larr;</button>
          <span className="year-label">{year}</span>
          <button className="btn-icon" onClick={() => { setYear(year + 1); setSelectedMonth(null); }}>&rarr;</button>
        </div>
      </div>

      {isLoading ? (
        <div className="loading">Loading...</div>
      ) : (
        <>
          {/* Big stat */}
          <div className="stat-row">
            <div className="stat-card">
              <div className="stat-value" style={{ fontSize: 36, color: '#1B5E20' }}>
                {totalCustomers}
              </div>
              <div className="stat-title">
                Total Customers &mdash; {repeatCustomers} repeat ({repeatRate}%)
              </div>
            </div>
          </div>

          {/* Three stat cards */}
          <div className="stat-row" style={{ display: 'flex', gap: '16px', marginBottom: '16px', flexWrap: 'wrap' }}>
            <div className="stat-card card" style={{ flex: 1, minWidth: '140px', textAlign: 'center', padding: '16px' }}>
              <div className="stat-value" style={{ fontSize: 24, color: '#1B5E20' }}>
                {formatCurrency(repeatRevenue)}
              </div>
              <div className="stat-title">Repeat Revenue</div>
            </div>
            <div className="stat-card card" style={{ flex: 1, minWidth: '140px', textAlign: 'center', padding: '16px' }}>
              <div className="stat-value" style={{ fontSize: 24, color: '#81C784' }}>
                {formatCurrency(newCustomerRevenue)}
              </div>
              <div className="stat-title">New Customer Revenue</div>
            </div>
            <div className="stat-card card" style={{ flex: 1, minWidth: '140px', textAlign: 'center', padding: '16px' }}>
              <div className="stat-value" style={{ fontSize: 24, color: '#FFA726' }}>
                {formatCurrency(cashRevenue)}
              </div>
              <div className="stat-title">Cash Jobs ({cashJobCount})</div>
            </div>
          </div>

          {/* Donut chart */}
          <div className="card chart-card">
            <h3>Revenue Breakdown</h3>
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie
                  data={donutData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  dataKey="value"
                  label={(props: PieLabelRenderProps) =>
                    `${props.name || ''} ${((Number(props.percent) || 0) * 100).toFixed(0)}%`
                  }
                >
                  {donutData.map((_, idx) => (
                    <Cell key={idx} fill={DONUT_COLORS[idx % DONUT_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => formatCurrency(Number(v))} />
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* Month grid or month detail */}
          {selectedMonth === null ? (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '12px',
              marginTop: '16px',
            }}>
              {MONTHS.map((monthName, idx) => {
                const monthNum = idx + 1;
                const isCurrentMonth = monthNum === now.getMonth() + 1 && year === now.getFullYear();

                return (
                  <MonthButton
                    key={monthNum}
                    monthNum={monthNum}
                    monthName={monthName}
                    year={year}
                    isCurrentMonth={isCurrentMonth}
                    onClick={() => handleMonthClick(monthNum)}
                  />
                );
              })}
            </div>
          ) : (
            <div style={{ marginTop: '16px' }}>
              <button className="btn-secondary" onClick={handleBack} style={{ marginBottom: '12px' }}>
                &larr; Back
              </button>
              <h3>{MONTHS[selectedMonth - 1]} {year} Customers</h3>
              {loadingMonth ? (
                <div className="loading">Loading...</div>
              ) : monthEntries.length === 0 ? (
                <div className="card text-center text-muted" style={{ padding: 32 }}>
                  No customers for this month.
                </div>
              ) : (
                <div className="card">
                  <p style={{ marginBottom: 12 }}>
                    <strong>{monthCustomerNames.size}</strong> unique customers
                    {cashMonthEntries.length > 0 && (
                      <span style={{ color: '#FFA726', marginLeft: 12 }}>
                        + {cashMonthEntries.length} cash job{cashMonthEntries.length !== 1 ? 's' : ''} ({formatCurrency(cashMonthTotal)})
                      </span>
                    )}
                  </p>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Customer</th>
                        <th>Amount</th>
                        <th>Job Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* Real customers first */}
                      {realMonthEntries.map((entry, i) => (
                        <tr key={`c-${i}`}>
                          <td>{entry.customer_name}</td>
                          <td className="text-right">{formatCurrency(entry.amount)}</td>
                          <td>{entry.job_type || '-'}</td>
                        </tr>
                      ))}
                      {/* Cash entries separated */}
                      {cashMonthEntries.length > 0 && (
                        <>
                          <tr>
                            <td colSpan={3} style={{ backgroundColor: '#FFF8E1', fontWeight: 'bold', paddingTop: 12 }}>
                              Cash Jobs
                            </td>
                          </tr>
                          {cashMonthEntries.map((entry, i) => (
                            <tr key={`cash-${i}`} style={{ backgroundColor: '#FFFDE7' }}>
                              <td style={{ color: '#F57C00' }}>{entry.customer_name}</td>
                              <td className="text-right">{formatCurrency(entry.amount)}</td>
                              <td>{entry.job_type || '-'}</td>
                            </tr>
                          ))}
                        </>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Top 10 Customers by Revenue */}
          <div className="card" style={{ marginTop: '24px' }}>
            <h3>Top 10 Customers by Revenue ({year})</h3>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Jobs</th>
                  <th>Total Revenue</th>
                </tr>
              </thead>
              <tbody>
                {topCustomers.length === 0 && (
                  <tr><td colSpan={3} className="text-center text-muted">No data available.</td></tr>
                )}
                {topCustomers.slice(0, 10).map((c, i) => (
                  <tr key={i}>
                    <td>
                      {c.customer_name}
                      {c.job_count > 1 && (
                        <span style={{ marginLeft: 8, fontSize: '0.8em', color: '#1B5E20', fontWeight: 600 }}>
                          REPEAT
                        </span>
                      )}
                    </td>
                    <td>{c.job_count}</td>
                    <td className="text-right">{formatCurrency(c.total_revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/** Month button that fetches its own customer count (excluding cash) */
function MonthButton({
  monthNum,
  monthName,
  year,
  isCurrentMonth,
  onClick,
}: {
  monthNum: number;
  monthName: string;
  year: number;
  isCurrentMonth: boolean;
  onClick: () => void;
}) {
  const { data } = useIncome(monthNum, year);
  const entries: IncomeEntry[] = data?.data || [];
  const realEntries = entries.filter((e) => !isCashEntry(e.customer_name));
  const uniqueCustomers = new Set(realEntries.map((e) => e.customer_name));
  const count = uniqueCustomers.size;

  return (
    <button
      className="card"
      onClick={onClick}
      style={{
        cursor: 'pointer',
        padding: '16px',
        textAlign: 'center',
        border: isCurrentMonth ? '2px solid #1B5E20' : '1px solid #e0e0e0',
        backgroundColor: isCurrentMonth ? '#E8F5E9' : '#fff',
        borderRadius: '8px',
        transition: 'box-shadow 0.2s',
      }}
    >
      <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>{monthName}</div>
      <div style={{ color: '#1B5E20', fontWeight: 600 }}>
        {count} customer{count !== 1 ? 's' : ''}
      </div>
    </button>
  );
}
