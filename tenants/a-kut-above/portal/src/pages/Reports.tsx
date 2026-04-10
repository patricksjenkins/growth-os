import { useState, useRef } from 'react';
import { usePLReport } from '../hooks/useFinance';
import { formatCurrency, MONTHS } from '../utils';

interface MonthlyEntry {
  income: number;
  expenses: number;
  net: number;
}

interface PLReport {
  year: number;
  total_income: number;
  total_expenses: number;
  net_profit: number;
  profit_margin: number;
  expenses_by_category: Record<string, number>;
  monthly_breakdown: Record<string, MonthlyEntry>;
  income_entries?: unknown[];
  expense_entries?: unknown[];
}

export default function Reports() {
  const [year, setYear] = useState(new Date().getFullYear());
  const reportRef = useRef<HTMLDivElement>(null);
  const { data, isLoading } = usePLReport(year);

  const report: PLReport | null = data?.data || null;

  // Compute best/worst month from monthly_breakdown
  let bestMonth = '';
  let worstMonth = '';
  if (report?.monthly_breakdown) {
    let bestNet = -Infinity;
    let worstNet = Infinity;
    for (let m = 1; m <= 12; m++) {
      const entry = report.monthly_breakdown[String(m)];
      if (!entry) continue;
      if (entry.net > bestNet) { bestNet = entry.net; bestMonth = MONTHS[m - 1]; }
      if (entry.net < worstNet) { worstNet = entry.net; worstMonth = MONTHS[m - 1]; }
    }
  }

  const avgMonthlyIncome = report ? report.total_income / 12 : 0;

  const handlePrint = () => {
    const content = reportRef.current;
    if (!content) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    printWindow.document.write(`
      <html>
      <head>
        <title>P&L Report - ${year}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 40px; color: #111; }
          h1, h2 { color: #1B5E20; }
          table { width: 100%; border-collapse: collapse; margin: 16px 0; }
          th, td { padding: 8px 12px; border-bottom: 1px solid #ddd; text-align: right; }
          th:first-child, td:first-child { text-align: left; }
          th { background: #f5f5f5; font-weight: 600; }
          .total-row { font-weight: bold; border-top: 2px solid #333; }
          .net-row { font-size: 1.2em; }
          .positive { color: #1B5E20; }
          .negative { color: #C62828; }
          .report-header { text-align: center; margin-bottom: 32px; border-bottom: 3px solid #1B5E20; padding-bottom: 16px; }
          .summary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 24px; }
          .summary-item { padding: 8px; background: #f9f9f9; border-radius: 4px; }
        </style>
      </head>
      <body>${content.innerHTML}</body>
      </html>
    `);
    printWindow.document.close();
    printWindow.print();
  };

  return (
    <div className="page-reports">
      <div className="page-header">
        <h2>Year-End Report</h2>
        <div className="year-selector">
          <button className="btn-icon" onClick={() => setYear(year - 1)}>&larr;</button>
          <span className="year-label">{year}</span>
          <button className="btn-icon" onClick={() => setYear(year + 1)}>&rarr;</button>
        </div>
        <button className="btn-primary" onClick={handlePrint}>Print Report</button>
      </div>

      {isLoading ? (
        <div className="loading">Loading...</div>
      ) : !report ? (
        <div className="card text-center text-muted" style={{ padding: 32 }}>No report data available for {year}.</div>
      ) : (
        <div className="card report-card" ref={reportRef}>
          <div className="report-header">
            <h1>A Kut Above Tree Services</h1>
            <h2>Profit &amp; Loss Statement</h2>
            <p>Fiscal Year {report.year || year}</p>
          </div>

          {/* Income Section */}
          <h3>Income</h3>
          <table className="data-table report-table">
            <thead>
              <tr>
                <th>Month</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {MONTHS.map((monthName, idx) => {
                const monthNum = String(idx + 1);
                const entry = report.monthly_breakdown?.[monthNum];
                const income = entry?.income ?? 0;
                return (
                  <tr key={idx}>
                    <td>{monthName}</td>
                    <td className="text-right">{formatCurrency(income)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="total-row">
                <td><strong>Total Income</strong></td>
                <td className="text-right"><strong>{formatCurrency(report.total_income)}</strong></td>
              </tr>
            </tfoot>
          </table>

          {/* Expenses by Category */}
          <h3>Expenses by Category</h3>
          <table className="data-table report-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {report.expenses_by_category && Object.entries(report.expenses_by_category).map(([category, total]) => (
                <tr key={category}>
                  <td>{category.replace(/_/g, ' ')}</td>
                  <td className="text-right">{formatCurrency(total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="total-row">
                <td><strong>Total Expenses</strong></td>
                <td className="text-right"><strong>{formatCurrency(report.total_expenses)}</strong></td>
              </tr>
            </tfoot>
          </table>

          {/* Net Profit/Loss */}
          <table className="data-table report-table" style={{ marginTop: 24 }}>
            <tfoot>
              <tr className={`total-row net-row ${report.net_profit >= 0 ? 'positive' : 'negative'}`}>
                <td><strong>Net {report.net_profit >= 0 ? 'Profit' : 'Loss'}</strong></td>
                <td className="text-right"><strong>{formatCurrency(report.net_profit)}</strong></td>
              </tr>
            </tfoot>
          </table>

          {/* Summary Metrics */}
          <div style={{ marginTop: 32 }}>
            <h3>Summary Metrics</h3>
            <div className="summary-grid">
              <div className="summary-item">
                <span className="text-muted">Profit Margin</span>
                <br />
                <strong>{report.profit_margin}%</strong>
              </div>
              <div className="summary-item">
                <span className="text-muted">Avg Monthly Income</span>
                <br />
                <strong>{formatCurrency(avgMonthlyIncome)}</strong>
              </div>
              <div className="summary-item">
                <span className="text-muted">Best Month</span>
                <br />
                <strong>{bestMonth}</strong>
              </div>
              <div className="summary-item">
                <span className="text-muted">Worst Month</span>
                <br />
                <strong>{worstMonth}</strong>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
