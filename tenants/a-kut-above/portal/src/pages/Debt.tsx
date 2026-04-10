import { useState } from 'react';
import { useDebts, useAddDebt, useUpdateDebt, useDeleteDebt } from '../hooks/useFinance';
import ProgressBar from '../components/ProgressBar';
import { formatCurrency, getIdField } from '../utils';

interface DebtItem {
  _id?: string;
  id?: number;
  name: string;
  original_amount: number;
  current_balance: number;
  monthly_payment: number;
}

export default function Debt() {
  const { data, isLoading } = useDebts();
  const addMut = useAddDebt();
  const updateMut = useUpdateDebt();
  const deleteMut = useDeleteDebt();

  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [originalAmount, setOriginalAmount] = useState('');
  const [currentBalance, setCurrentBalance] = useState('');
  const [monthlyPayment, setMonthlyPayment] = useState('');

  const debts: DebtItem[] = data?.data || data || [];
  const totalRemaining = debts.reduce((s, d) => s + (d.current_balance || 0), 0);

  const resetForm = () => {
    setName(''); setOriginalAmount(''); setCurrentBalance('');
    setMonthlyPayment(''); setEditId(null); setShowForm(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      name,
      original_amount: parseFloat(originalAmount),
      current_balance: parseFloat(currentBalance),
      monthly_payment: parseFloat(monthlyPayment),
    };
    if (editId) {
      await updateMut.mutateAsync({ id: editId, data: payload });
    } else {
      await addMut.mutateAsync(payload);
    }
    resetForm();
  };

  const handleEdit = (d: DebtItem) => {
    setEditId(getIdField(d));
    setName(d.name);
    setOriginalAmount(String(d.original_amount));
    setCurrentBalance(String(d.current_balance));
    setMonthlyPayment(String(d.monthly_payment));
    setShowForm(true);
  };

  const handleDelete = async (d: DebtItem) => {
    if (confirm(`Delete ${d.name}?`)) {
      await deleteMut.mutateAsync(getIdField(d));
    }
  };

  return (
    <div className="page-debt">
      <div className="page-header">
        <h2>Debt Tracker</h2>
        <button className="btn-primary" onClick={() => { resetForm(); setShowForm(true); }}>+ Add Debt</button>
      </div>

      <div className="stat-row">
        <div className="stat-card">
          <div className="stat-title">Total Remaining Debt</div>
          <div className="stat-value" style={{ color: '#C62828' }}>{formatCurrency(totalRemaining)}</div>
        </div>
      </div>

      {showForm && (
        <div className="card form-card">
          <h3>{editId ? 'Edit Debt' : 'Add Debt'}</h3>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Original Amount</label>
                <input type="number" step="0.01" value={originalAmount} onChange={(e) => setOriginalAmount(e.target.value)} required />
              </div>
              <div className="form-group">
                <label>Current Balance</label>
                <input type="number" step="0.01" value={currentBalance} onChange={(e) => setCurrentBalance(e.target.value)} required />
              </div>
              <div className="form-group">
                <label>Monthly Payment</label>
                <input type="number" step="0.01" value={monthlyPayment} onChange={(e) => setMonthlyPayment(e.target.value)} required />
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

      {isLoading ? (
        <div className="loading">Loading...</div>
      ) : debts.length === 0 ? (
        <div className="card text-center text-muted" style={{ padding: 32 }}>No debts tracked.</div>
      ) : (
        <div className="debt-list">
          {debts.map((d) => {
            const paid = d.original_amount - d.current_balance;
            return (
              <div key={getIdField(d)} className="card debt-card">
                <div className="debt-card-header">
                  <h3>{d.name}</h3>
                  <div className="debt-card-actions">
                    <button className="btn-sm" onClick={() => handleEdit(d)}>Edit</button>
                    <button className="btn-sm btn-danger" onClick={() => handleDelete(d)}>Delete</button>
                  </div>
                </div>
                <div className="debt-info-row">
                  <span>Original: {formatCurrency(d.original_amount)}</span>
                  <span>Remaining: {formatCurrency(d.current_balance)}</span>
                  <span>Payment: {formatCurrency(d.monthly_payment)}/mo</span>
                </div>
                <ProgressBar value={paid} max={d.original_amount} label={`Paid: ${formatCurrency(paid)}`} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
