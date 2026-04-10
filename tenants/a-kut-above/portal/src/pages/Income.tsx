import { useState, useEffect, useRef } from 'react';
import { useIncome, useAddIncome, useUpdateIncome, useDeleteIncome, useYearlySummary } from '../hooks/useFinance';
import { searchCustomers } from '../api/finance';
import type { IncomeEntry } from '../api/finance';
import { formatCurrency, formatDate, getIdField, MONTHS } from '../utils';

type ViewMode = 'year' | 'month';

export default function Income() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('year');
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const [customerName, setCustomerName] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [jobType, setJobType] = useState('');
  const [notes, setNotes] = useState('');
  const [suggestions, setSuggestions] = useState<Array<{ name: string; jobs: number; total_revenue: number }>>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const sugRef = useRef<HTMLDivElement>(null);

  const { data: summaryData } = useYearlySummary(year);
  const { data: monthData, isLoading: loadingMonth } = useIncome(selectedMonth || 1, year);
  const addMut = useAddIncome();
  const updateMut = useUpdateIncome();
  const deleteMut = useDeleteIncome();

  const summary = summaryData?.data || {};
  const breakdown = summary.monthly_breakdown || {};
  const yearlyTotal = summary.total_income ?? 0;

  const entries: IncomeEntry[] = (monthData?.data || []);
  const monthTotal = entries.reduce((s, e) => s + (e.amount || 0), 0);

  useEffect(() => {
    if (customerName.length < 2) { setSuggestions([]); return; }
    const timer = setTimeout(async () => {
      try {
        const res = await searchCustomers(customerName);
        setSuggestions(res.data || res || []);
        setShowSuggestions(true);
      } catch { setSuggestions([]); }
    }, 300);
    return () => clearTimeout(timer);
  }, [customerName]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (sugRef.current && !sugRef.current.contains(e.target as Node)) setShowSuggestions(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const resetForm = () => {
    setCustomerName(''); setAmount(''); setDate(new Date().toISOString().slice(0, 10));
    setJobType(''); setNotes(''); setEditId(null); setShowForm(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      customer_name: customerName,
      amount: parseFloat(amount),
      date,
      job_type: jobType || undefined,
      notes: notes || undefined,
    };
    if (editId) {
      await updateMut.mutateAsync({ id: editId, data: payload });
    } else {
      await addMut.mutateAsync(payload);
    }
    resetForm();
  };

  const handleEdit = (entry: IncomeEntry) => {
    setEditId(getIdField(entry));
    setCustomerName(entry.customer_name);
    setAmount(String(entry.amount));
    setDate(entry.date?.slice(0, 10) || '');
    setJobType(entry.job_type || '');
    setNotes(entry.notes || '');
    setShowForm(true);
  };

  const handleDelete = async (entry: IncomeEntry) => {
    if (confirm('Delete this income entry?')) {
      await deleteMut.mutateAsync(getIdField(entry));
    }
  };

  const handleMonthClick = (month: number) => {
    setSelectedMonth(month);
    setViewMode('month');
  };

  const handleBack = () => {
    setViewMode('year');
    setSelectedMonth(null);
    resetForm();
  };

  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  // Year overview
  if (viewMode === 'year') {
    return (
      <div className="page-income">
        <div className="page-header">
          <h2>Income</h2>
          <div className="year-selector">
            <button className="btn-icon" onClick={() => setYear(year - 1)}>&larr;</button>
            <span className="year-label">{year}</span>
            <button className="btn-icon" onClick={() => setYear(year + 1)}>&rarr;</button>
          </div>
        </div>

        <div className="card" style={{ textAlign: 'center', padding: '24px' }}>
          <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#666' }}>{year} Total Income</h3>
          <p style={{ fontSize: '2rem', fontWeight: 'bold', color: '#1B5E20', margin: '8px 0 0' }}>
            {formatCurrency(yearlyTotal)}
          </p>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '12px',
          marginTop: '16px',
        }}>
          {MONTHS.map((monthName, idx) => {
            const monthNum = idx + 1;
            const monthBreakdown = breakdown[String(monthNum)] || {};
            const monthIncome = monthBreakdown.income ?? 0;
            const isCurrentMonth = monthNum === currentMonth && year === currentYear;

            return (
              <button
                key={monthNum}
                className="card"
                onClick={() => handleMonthClick(monthNum)}
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
                <div style={{ color: '#1B5E20', fontWeight: 600 }}>{formatCurrency(monthIncome)}</div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // Month detail view
  return (
    <div className="page-income">
      <div className="page-header">
        <button className="btn-secondary" onClick={handleBack}>&larr; Back</button>
        <h2>{MONTHS[(selectedMonth || 1) - 1]} {year} - Income</h2>
        <button className="btn-primary" onClick={() => { resetForm(); setShowForm(true); }}>+ Add Income</button>
      </div>

      {showForm && (
        <div className="card form-card">
          <h3>{editId ? 'Edit Income' : 'Add Income'}</h3>
          <form onSubmit={handleSubmit}>
            <div className="form-group" style={{ position: 'relative' }} ref={sugRef}>
              <label>Customer Name</label>
              <input
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                required
              />
              {showSuggestions && suggestions.length > 0 && (
                <div className="autocomplete-dropdown">
                  {suggestions.map((s, i) => (
                    <div
                      key={i}
                      className="autocomplete-item"
                      onClick={() => { setCustomerName(s.name); setShowSuggestions(false); }}
                    >
                      <strong>{s.name}</strong>
                      <span className="text-muted"> - {s.jobs} jobs, {formatCurrency(s.total_revenue)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Amount</label>
                <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
              </div>
              <div className="form-group">
                <label>Date</label>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Job Type (optional)</label>
                <input value={jobType} onChange={(e) => setJobType(e.target.value)} />
              </div>
              <div className="form-group">
                <label>Notes (optional)</label>
                <input value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
            </div>
            <div className="form-actions">
              <button type="submit" className="btn-primary" disabled={addMut.isPending || updateMut.isPending}>
                {editId ? 'Update' : 'Save'}
              </button>
              <button type="button" className="btn-secondary" onClick={resetForm}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {loadingMonth ? (
        <div className="loading">Loading...</div>
      ) : (
        <div className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Amount</th>
                <th>Date</th>
                <th>Type</th>
                <th>Notes</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && (
                <tr><td colSpan={6} className="text-center text-muted">No income entries for this month.</td></tr>
              )}
              {entries.map((entry, i) => (
                <tr key={getIdField(entry) || i}>
                  <td>{entry.customer_name}</td>
                  <td className="text-right">{formatCurrency(entry.amount)}</td>
                  <td>{formatDate(entry.date)}</td>
                  <td>{entry.job_type || '-'}</td>
                  <td>{entry.notes || '-'}</td>
                  <td>
                    <button className="btn-sm" onClick={() => handleEdit(entry)}>Edit</button>
                    <button className="btn-sm btn-danger" onClick={() => handleDelete(entry)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td><strong>Total</strong></td>
                <td className="text-right"><strong>{formatCurrency(monthTotal)}</strong></td>
                <td colSpan={4} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
