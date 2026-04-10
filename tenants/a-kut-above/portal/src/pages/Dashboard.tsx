import { useState } from 'react';
import { useYearlySummary, useCustomerInsights, useDebts } from '../hooks/useFinance';
import StatCard from '../components/StatCard';
import ProgressBar from '../components/ProgressBar';
import { formatCurrency, MONTHS } from '../utils';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

export default function Dashboard() {
  const [year, setYear] = useState(new Date().getFullYear());

  const { data: summaryData, isLoading } = useYearlySummary(year);
  const { data: insightsData } = useCustomerInsights(year);
  const { data: debtsData } = useDebts();

  const summary = summaryData?.data || {};
  const insights = insightsData?.data || {};
  const debtsArray = Array.isArray(debtsData?.data) ? debtsData.data as Array<{
    name: string; original_amount: number; current_balance: number; progress_pct: number;
  }> : [];

  const totalIncome = summary.total_income ?? 0;
  const totalExpenses = summary.total_expenses ?? 0;
  const netProfit = summary.net_profit ?? (totalIncome - totalExpenses);

  // Monthly chart data - monthly_breakdown is an object with keys "1"-"12"
  const breakdown = summary.monthly_breakdown || {};
  const monthlyData = Object.entries(breakdown).map(([key, val]: [string, any]) => ({
    name: MONTHS[parseInt(key) - 1]?.substring(0, 3),
    Income: val.income || 0,
    Expenses: val.expenses || 0,
  }));

  // Debt totals
  const totalDebt = debtsArray.reduce((s, d) => s + (d.current_balance || 0), 0);

  return (
    <div className="page-dashboard">
      <div className="page-header">
        <h2>Dashboard</h2>
        <div className="year-selector">
          <button className="btn-icon" onClick={() => setYear(year - 1)}>&larr;</button>
          <span className="year-label">{year}</span>
          <button className="btn-icon" onClick={() => setYear(year + 1)}>&rarr;</button>
        </div>
      </div>

      {isLoading ? (
        <div className="loading">Loading...</div>
      ) : (
        <>
          <div className="stat-row">
            <StatCard title="Total Income" value={totalIncome} color="#1B5E20" />
            <StatCard title="Total Expenses" value={totalExpenses} color="#C62828" />
            <StatCard title="Net Profit" value={netProfit} color={netProfit >= 0 ? '#1B5E20' : '#C62828'} />
          </div>

          {monthlyData.length > 0 && (
            <div className="card chart-card">
              <h3>Monthly Income vs Expenses</h3>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={monthlyData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" />
                  <YAxis tickFormatter={(v) => `$${(Number(v) / 1000).toFixed(0)}k`} />
                  <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                  <Legend />
                  <Bar dataKey="Income" fill="#1B5E20" />
                  <Bar dataKey="Expenses" fill="#C62828" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="two-col">
            <div className="card">
              <h3>Customer Insights</h3>
              <div className="insight-row">
                <span>Total Customers:</span>
                <strong>{insights.total_customers ?? 0}</strong>
              </div>
              <div className="insight-row">
                <span>Repeat Customers:</span>
                <strong>{insights.repeat_customers ?? 0}</strong>
              </div>
              <div className="insight-row">
                <span>Repeat Rate:</span>
                <strong>{insights.repeat_rate ? `${insights.repeat_rate}%` : '0%'}</strong>
              </div>
              {insights.top_customers && (
                <>
                  <h4 style={{ marginTop: 16 }}>Top Customers</h4>
                  {(insights.top_customers as Array<{ customer_name: string; total_revenue: number; job_count: number }>)
                    .slice(0, 5)
                    .map((c, i) => (
                      <div key={i} className="insight-row">
                        <span>{c.customer_name}</span>
                        <strong>{formatCurrency(c.total_revenue)} ({c.job_count} jobs)</strong>
                      </div>
                    ))}
                </>
              )}
            </div>
          </div>

          {debtsArray.length > 0 && (
            <div className="card">
              <h3>Debt Overview</h3>
              <p className="debt-total">Total Remaining: {formatCurrency(totalDebt)}</p>
              {debtsArray.map((d, i) => (
                <ProgressBar
                  key={i}
                  label={d.name}
                  value={d.original_amount - d.current_balance}
                  max={d.original_amount}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
