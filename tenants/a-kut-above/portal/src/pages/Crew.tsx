import { useState } from 'react';
import {
  useCrewMembers, useAddCrewMember, useDeleteCrewMember, useUpdateCrewMember,
  useCrewLogs, useToggleCrewLog, useCrewYearlySummary,
} from '../hooks/useFinance';
import { formatCurrency, getIdField, MONTHS } from '../utils';

interface CrewMember {
  _id?: string;
  id?: number;
  name: string;
  daily_rate: number;
}

interface CrewSummaryMember {
  id: string;
  name: string;
  daily_rate: number;
  days_worked: number;
  total_pay: number;
}

interface MonthBreakdown {
  crew: CrewSummaryMember[];
  grand_total: number;
}

export default function Crew() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newRate, setNewRate] = useState('');
  const [editingRate, setEditingRate] = useState<string | null>(null);
  const [editRateValue, setEditRateValue] = useState('');

  const { data: crewData, isLoading: loadingCrew } = useCrewMembers();
  const { data: yearlyData, isLoading: loadingYearly } = useCrewYearlySummary(year);
  const { data: logsData } = useCrewLogs(selectedMonth || 1, year);
  const addMut = useAddCrewMember();
  const deleteMut = useDeleteCrewMember();
  const updateMut = useUpdateCrewMember();
  const toggleMut = useToggleCrewLog();

  const crew: CrewMember[] = crewData?.data || crewData || [];
  const yearly = yearlyData?.data || null;
  const monthlyBreakdown: Record<string, MonthBreakdown> = yearly?.monthly_breakdown || {};
  const yearlyGrandTotal: number = yearly?.grand_total ?? 0;
  const yearlyCrew: CrewSummaryMember[] = yearly?.crew || [];

  const logs = logsData?.data || logsData || [];

  const handleMonthClick = (month: number) => {
    setSelectedMonth(month);
  };

  const handleBack = () => {
    setSelectedMonth(null);
  };

  const handleAddCrew = async (e: React.FormEvent) => {
    e.preventDefault();
    await addMut.mutateAsync({ name: newName, daily_rate: parseFloat(newRate) });
    setNewName(''); setNewRate(''); setShowAddForm(false);
  };

  const handleDeleteCrew = async (member: CrewMember) => {
    if (confirm(`Remove ${member.name} from crew?`)) {
      await deleteMut.mutateAsync(getIdField(member));
    }
  };

  const handleStartEditRate = (member: CrewMember) => {
    setEditingRate(getIdField(member));
    setEditRateValue(String(member.daily_rate));
  };

  const handleSaveRate = async (member: CrewMember) => {
    const newDailyRate = parseFloat(editRateValue);
    if (isNaN(newDailyRate) || newDailyRate <= 0) return;
    await updateMut.mutateAsync({ id: getIdField(member), data: { daily_rate: newDailyRate } });
    setEditingRate(null);
  };

  const handleCancelEditRate = () => {
    setEditingRate(null);
  };

  // For month detail: day grid
  const daysInMonth = selectedMonth ? new Date(year, selectedMonth, 0).getDate() : 0;
  const dayNumbers = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  const isWorked = (memberId: string, day: number) => {
    const dateStr = `${year}-${String(selectedMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return (logs as any[]).some(
      (l: any) => l.crew_member_id === memberId && l.date?.startsWith(dateStr) && l.worked
    );
  };

  const handleToggle = (memberId: string, day: number) => {
    const dateStr = `${year}-${String(selectedMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    toggleMut.mutate({ crew_member_id: memberId, date: dateStr });
  };

  const getDaysWorked = (memberId: string) => {
    return dayNumbers.filter((d) => isWorked(memberId, d)).length;
  };

  return (
    <div className="page-crew">
      <div className="page-header">
        <h2>Crew Management</h2>
        <div className="year-selector">
          <button className="btn-icon" onClick={() => setYear(year - 1)}>&larr;</button>
          <span className="year-label">{year}</span>
          <button className="btn-icon" onClick={() => setYear(year + 1)}>&rarr;</button>
        </div>
        <button className="btn-primary" onClick={() => setShowAddForm(true)}>+ Add Crew Member</button>
      </div>

      {showAddForm && (
        <div className="card form-card">
          <h3>Add Crew Member</h3>
          <form onSubmit={handleAddCrew}>
            <div className="form-row">
              <div className="form-group">
                <label>Name</label>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} required />
              </div>
              <div className="form-group">
                <label>Daily Rate ($)</label>
                <input type="number" step="0.01" value={newRate} onChange={(e) => setNewRate(e.target.value)} required />
              </div>
            </div>
            <div className="form-actions">
              <button type="submit" className="btn-primary" disabled={addMut.isPending}>Save</button>
              <button type="button" className="btn-secondary" onClick={() => setShowAddForm(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {/* Crew Members List with Rate Editing */}
      {!loadingCrew && crew.length > 0 && (
        <div className="card" style={{ marginBottom: '16px' }}>
          <h3>Active Crew Members</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Daily Rate</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {crew.map((member) => {
                const memberId = getIdField(member);
                const isEditing = editingRate === memberId;
                return (
                  <tr key={memberId}>
                    <td><strong>{member.name}</strong></td>
                    <td>
                      {isEditing ? (
                        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                          <span>$</span>
                          <input
                            type="number"
                            step="0.01"
                            value={editRateValue}
                            onChange={(e) => setEditRateValue(e.target.value)}
                            style={{ width: '80px', padding: '4px' }}
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveRate(member);
                              if (e.key === 'Escape') handleCancelEditRate();
                            }}
                          />
                          <button className="btn-sm btn-primary" onClick={() => handleSaveRate(member)} disabled={updateMut.isPending}>
                            {updateMut.isPending ? '...' : 'Save'}
                          </button>
                          <button className="btn-sm btn-secondary" onClick={handleCancelEditRate}>Cancel</button>
                        </div>
                      ) : (
                        <span
                          style={{ cursor: 'pointer', borderBottom: '1px dashed #999' }}
                          onClick={() => handleStartEditRate(member)}
                          title="Click to edit rate"
                        >
                          {formatCurrency(member.daily_rate)}/day
                        </span>
                      )}
                    </td>
                    <td>
                      <button className="btn-sm btn-danger" onClick={() => handleDeleteCrew(member)}>Remove</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(loadingCrew || loadingYearly) ? (
        <div className="loading">Loading...</div>
      ) : selectedMonth === null ? (
        <>
          {/* Year Total */}
          <div className="stat-row">
            <div className="stat-card">
              <div className="stat-value" style={{ fontSize: 36, color: '#1B5E20' }}>
                {formatCurrency(yearlyGrandTotal)}
              </div>
              <div className="stat-title">Total Crew Pay &mdash; {year}</div>
            </div>
          </div>

          {/* Yearly crew summary */}
          {yearlyCrew.length > 0 && (
            <div className="card" style={{ marginBottom: '16px' }}>
              <h3>{year} Summary by Crew Member</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Rate</th>
                    <th>Days Worked</th>
                    <th>Total Pay</th>
                  </tr>
                </thead>
                <tbody>
                  {yearlyCrew.map((c) => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td>{formatCurrency(c.daily_rate)}/day</td>
                      <td>{c.days_worked}</td>
                      <td className="text-right">{formatCurrency(c.total_pay)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2}><strong>Total</strong></td>
                    <td><strong>{yearlyCrew.reduce((s, c) => s + c.days_worked, 0)}</strong></td>
                    <td className="text-right"><strong>{formatCurrency(yearlyGrandTotal)}</strong></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* 12 Month Buttons */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '12px',
            marginTop: '16px',
          }}>
            {MONTHS.map((monthName, idx) => {
              const monthNum = idx + 1;
              const monthData = monthlyBreakdown[String(monthNum)];
              const monthTotal = monthData?.grand_total ?? 0;
              const crewCount = monthData?.crew?.length ?? 0;
              const isCurrentMonth = monthNum === now.getMonth() + 1 && year === now.getFullYear();

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
                  <div style={{ color: '#1B5E20', fontWeight: 600 }}>
                    {formatCurrency(monthTotal)}
                  </div>
                  <div style={{ color: '#666', fontSize: '0.85em' }}>
                    {crewCount} crew member{crewCount !== 1 ? 's' : ''}
                  </div>
                </button>
              );
            })}
          </div>
        </>
      ) : (
        /* Month Detail View */
        <div style={{ marginTop: '16px' }}>
          <button className="btn-secondary" onClick={handleBack} style={{ marginBottom: '12px' }}>
            &larr; Back
          </button>
          <h3>{MONTHS[selectedMonth - 1]} {year} &mdash; Crew</h3>

          {/* Monthly summary from yearly data */}
          {(() => {
            const monthData = monthlyBreakdown[String(selectedMonth)];
            const monthCrew = monthData?.crew || [];
            const monthTotal = monthData?.grand_total ?? 0;

            return (
              <div className="card" style={{ marginBottom: '16px' }}>
                <h4>Monthly Summary</h4>
                {monthCrew.length === 0 ? (
                  <div className="text-center text-muted" style={{ padding: 16 }}>
                    No crew work logged for this month.
                  </div>
                ) : (
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Rate</th>
                        <th>Days Worked</th>
                        <th>Total Pay</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthCrew.map((c: CrewSummaryMember) => (
                        <tr key={c.id}>
                          <td>{c.name}</td>
                          <td>{formatCurrency(c.daily_rate)}/day</td>
                          <td>{c.days_worked}</td>
                          <td className="text-right">{formatCurrency(c.total_pay)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={2}><strong>Total</strong></td>
                        <td><strong>{monthCrew.reduce((s: number, c: CrewSummaryMember) => s + c.days_worked, 0)}</strong></td>
                        <td className="text-right"><strong>{formatCurrency(monthTotal)}</strong></td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </div>
            );
          })()}

          {/* Day-by-day grid */}
          {crew.length > 0 && (
            <div className="card crew-grid-card">
              <h4>Daily Log</h4>
              <div className="crew-grid-wrapper">
                <table className="crew-grid">
                  <thead>
                    <tr>
                      <th className="crew-name-col">Crew Member</th>
                      {dayNumbers.map((d) => (
                        <th key={d} className="day-col">{d}</th>
                      ))}
                      <th className="crew-total-col">Days</th>
                      <th className="crew-total-col">Pay</th>
                    </tr>
                  </thead>
                  <tbody>
                    {crew.map((member) => {
                      const memberId = getIdField(member);
                      const daysWorked = getDaysWorked(memberId);
                      return (
                        <tr key={memberId}>
                          <td className="crew-name-col">
                            <strong>{member.name}</strong>
                            <div className="text-muted text-sm">{formatCurrency(member.daily_rate)}/day</div>
                          </td>
                          {dayNumbers.map((d) => (
                            <td
                              key={d}
                              className={`day-cell ${isWorked(memberId, d) ? 'worked' : ''}`}
                              onClick={() => handleToggle(memberId, d)}
                            />
                          ))}
                          <td className="crew-total-col"><strong>{daysWorked}</strong></td>
                          <td className="crew-total-col">{formatCurrency(daysWorked * member.daily_rate)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
