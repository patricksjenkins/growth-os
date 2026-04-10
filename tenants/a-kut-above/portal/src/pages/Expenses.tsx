import { useState } from 'react';
import { useExpenses, useAddExpense, useUpdateExpense, useDeleteExpense, useRolloverExpenses, useYearlySummary } from '../hooks/useFinance';
import type { ExpenseEntry } from '../api/finance';
import { formatCurrency, formatDate, getIdField, EXPENSE_CATEGORIES, MONTHS } from '../utils';

type ViewMode = 'year' | 'month';

export default function Expenses() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('year');
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('Operations');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [recurring, setRecurring] = useState(false);

  const { data: summaryData } = useYearlySummary(year);
  const { data: monthData, isLoading: loadingMonth } = useExpenses(selectedMonth || 1, year);
  const addMut = useAddExpense();
  const updateMut = useUpdateExpense();
  const deleteMut = useDeleteExpense();
  const rolloverMut = useRolloverExpenses();

  const summary = summaryData?.data || {};
  const breakdown = summary.monthly_breakdown || {};
  const yearlyTotal = summary.total_expenses ?? 0;

  const entries: ExpenseEntry[] = (monthData?.data || []);
  const monthTotal = entries.reduce((s, e) => s + (e.amount || 0), 0);

  // Group by category
  const grouped: Record<string, ExpenseEntry[]> = {};
  entries.forEach((e) => {
    const cat = e.category || 'Other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(e);
  });

  const resetForm = () => {
    setDescription(''); setCategory('Operations'); setAmount('');
    setDate(new Date().toISOString().slice(0, 10)); setRecurring(false);
    setEditId(null); setShowForm(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      description,
      category,
      amount: parseFloat(amount),
      date,
      recurring,
    };
    if (editId) {
      await updateMut.mutateAsync({ id: editId, data: payload });
    } else {
      await addMut.mutateAsync(payload);
    }
    resetForm();
  };

  const handleEdit = (entry: ExpenseEntry) => {
    setEditId(getIdField(entry));
    setDescription(entry.description);
    setCategory(entry.category);
    setAmount(String(entry.amount));
    setDate(entry.date?.slice(0, 10) || '');
    setRecurring(entry.recurring || false);
    setShowForm(true);
  };

  const handleDelete = async (entry: ExpenseEntry) => {
    if (confirm('Delete this expense?')) {
      await deleteMut.mutateAsync(getIdField(entry));
    }
  };

  const handleRollover = async () => {
    if (confirm('Roll over recurring expenses from last month?')) {
      await rolloverMut.mutateAsync({ month: selectedMonth || 1, year });
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
      <div className="page-expenses">
        <div className="page-header">
          <h2>Expenses</h2>
          <div className="year-selector">
            <button className="btn-icon" onClick={() => setYear(year - 1)}>&larr;</button>
            <span className="year-label">{year}</span>
            <button className="btn-icon" onClick={() => setYear(year + 1)}>&rarr;</button>
          </div>
        </div>

        <div className="card" style={{ textAlign: 'center', padding: '24px' }}>
          <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#666' }}>{year} Total Expenses</h3>
          <p style={{ fontSize: '2rem', fontWeight: 'bold', color: '#C62828', margin: '8px 0 0' }}>
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
            const monthExpenses = monthBreakdown.expenses ?? 0;
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
                  border: isCurrentMonth ? '2px solid #C62828' : '1px solid #e0e0e0',
                  backgroundColor: isCurrentMonth ? '#FFEBEE' : '#fff',
                  borderRadius: '8px',
                  transition: 'box-shadow 0.2s',
                }}
              >
                <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>{monthName}</div>
                <div style={{ color: '#C62828', fontWeight: 600 }}>{formatCurrency(monthExpenses)}</div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // Month detail view
  return (
    <div className="page-expenses">
      <div className="page-header">
        <button className="btn-secondary" onClick={handleBack}>&larr; Back</button>
        <h2>{MONTHS[(selectedMonth || 1) - 1]} {year} - Expenses</h2>
        <div className="header-actions">
          <button className="btn-secondary" onClick={handleRollover} disabled={rolloverMut.isPending}>
            Roll Over from Last Month
          </button>
          <button className="btn-primary" onClick={() => { resetForm(); setShowForm(true); }}>+ Add Expense</button>
        </div>
      </div>

      {showForm && (
        <div className="card form-card">
          <h3>{editId ? 'Edit Expense' : 'Add Expense'}</h3>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Description</label>
              <input value={description} onChange={(e) => setDescription(e.target.value)} required />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Category</label>
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Amount</label>
                <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
              </div>
              <div className="form-group">
                <label>Date</label>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
              </div>
            </div>
            <div className="form-group checkbox-group">
              <label>
                <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} />
                Recurring Expense
              </label>
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
        <>
          {Object.keys(grouped).sort().map((cat) => {
            const items = grouped[cat];
            const subtotal = items.reduce((s, e) => s + (e.amount || 0), 0);
            return (
              <div key={cat} className="card" style={{ marginBottom: 16 }}>
                <div className="category-header">
                  <h3>{cat.replace('_', ' ')}</h3>
                  <span className="category-subtotal">{formatCurrency(subtotal)}</span>
                </div>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Description</th>
                      <th>Category</th>
                      <th>Amount</th>
                      <th>Date</th>
                      <th>Recurring</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((entry, i) => (
                      <tr key={getIdField(entry) || i}>
                        <td>{entry.description}</td>
                        <td><span className="badge">{entry.category.replace('_', ' ')}</span></td>
                        <td className="text-right">{formatCurrency(entry.amount)}</td>
                        <td>{formatDate(entry.date)}</td>
                        <td>{entry.recurring ? 'Yes' : 'No'}</td>
                        <td>
                          <button className="btn-sm" onClick={() => handleEdit(entry)}>Edit</button>
                          <button className="btn-sm btn-danger" onClick={() => handleDelete(entry)}>Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
          {entries.length === 0 && (
            <div className="card text-center text-muted" style={{ padding: 32 }}>No expenses for this month.</div>
          )}
          <div className="total-bar">
            <strong>Monthly Total: {formatCurrency(monthTotal)}</strong>
          </div>
        </>
      )}
    </div>
  );
}
