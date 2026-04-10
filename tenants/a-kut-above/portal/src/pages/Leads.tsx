import { useState } from 'react';
import { useLeads, useUpdateLead } from '../hooks/useFinance';
import { formatCurrency, formatDate } from '../utils';

interface Lead {
  _id?: string;
  id?: number | string;
  name?: string;
  phone?: string;
  service_type?: string;
  lead_source?: string;
  status?: string;
  date_of_inquiry?: string;
  date_of_estimate?: string;
  estimate_amount?: number;
  final_revenue?: number;
  loss_reason?: string;
  notes?: string;
}

const STATUS_VALUES = ['', 'new_lead', 'estimate_given', 'won', 'lost', 'completed'] as const;

const STATUS_LABELS: Record<string, string> = {
  new_lead: 'New Lead',
  estimate_given: 'Estimate Given',
  won: 'Won',
  lost: 'Lost',
  completed: 'Completed',
};

function statusLabel(s?: string): string {
  if (!s) return '';
  return STATUS_LABELS[s] || s;
}

function statusColor(s?: string): string {
  switch (s) {
    case 'new_lead': return '#1976D2';
    case 'estimate_given': return '#F57C00';
    case 'won': return '#1B5E20';
    case 'lost': return '#C62828';
    case 'completed': return '#7B1FA2';
    default: return '#666';
  }
}

export default function Leads() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [editLead, setEditLead] = useState<Lead | null>(null);

  const { data, isLoading } = useLeads(status, page);
  const updateMut = useUpdateLead();

  const leads: Lead[] = data?.data || [];
  const totalPages = data?.totalPages || data?.pages || 1;

  // Edit form state
  const [editStatus, setEditStatus] = useState('');
  const [editEstimate, setEditEstimate] = useState('');
  const [editRevenue, setEditRevenue] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editLossReason, setEditLossReason] = useState('');

  const openEdit = (lead: Lead) => {
    setEditLead(lead);
    setEditStatus(lead.status || '');
    setEditEstimate(String(lead.estimate_amount ?? ''));
    setEditRevenue(String(lead.final_revenue ?? ''));
    setEditNotes(lead.notes || '');
    setEditLossReason(lead.loss_reason || '');
  };

  const closeEdit = () => {
    setEditLead(null);
  };

  const handleSave = async () => {
    if (!editLead) return;
    const id = editLead._id || String(editLead.id || '');
    const updates: Record<string, unknown> = {
      status: editStatus,
      estimate_amount: editEstimate ? parseFloat(editEstimate) : undefined,
      final_revenue: editRevenue ? parseFloat(editRevenue) : undefined,
      notes: editNotes || undefined,
    };
    if (editStatus === 'lost') {
      updates.loss_reason = editLossReason || undefined;
    }
    await updateMut.mutateAsync({ id, data: updates });
    closeEdit();
  };

  return (
    <div className="page-leads">
      <div className="page-header">
        <h2>Leads</h2>
        <div className="filter-bar">
          <label>Status:</label>
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            {STATUS_VALUES.map((s) => (
              <option key={s} value={s}>{s ? statusLabel(s) : 'All'}</option>
            ))}
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="loading">Loading...</div>
      ) : leads.length === 0 ? (
        <div className="card text-center text-muted" style={{ padding: 32 }}>No leads found.</div>
      ) : (
        <>
          <div className="card-grid">
            {leads.map((lead, i) => (
              <div
                key={lead._id || lead.id || i}
                className="card lead-card"
                style={{ cursor: 'pointer' }}
                onClick={() => openEdit(lead)}
              >
                <div className="lead-card-header">
                  <h3>{lead.name || 'Unknown'}</h3>
                  {lead.status && (
                    <span className="status-badge" style={{ backgroundColor: statusColor(lead.status), color: '#fff' }}>
                      {statusLabel(lead.status)}
                    </span>
                  )}
                </div>
                {lead.phone && <p>Phone: {lead.phone}</p>}
                {lead.service_type && <p>Service: {lead.service_type}</p>}
                <div className="lead-meta">
                  {lead.estimate_amount != null && (
                    <span>Estimate: {formatCurrency(lead.estimate_amount)}</span>
                  )}
                  {lead.final_revenue != null && (
                    <span>Revenue: {formatCurrency(lead.final_revenue)}</span>
                  )}
                  {lead.date_of_inquiry && (
                    <span>Inquiry: {formatDate(lead.date_of_inquiry)}</span>
                  )}
                  {lead.lead_source && <span>Source: {lead.lead_source}</span>}
                </div>
                {lead.notes && <p className="text-muted text-sm">{lead.notes}</p>}
              </div>
            ))}
          </div>

          {totalPages > 1 && (
            <div className="pagination">
              <button className="btn-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
              <span>Page {page} of {totalPages}</span>
              <button className="btn-secondary" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          )}
        </>
      )}

      {/* Edit Modal */}
      {editLead && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) closeEdit(); }}
        >
          <div
            className="card"
            style={{
              width: '90%',
              maxWidth: '500px',
              maxHeight: '90vh',
              overflow: 'auto',
              padding: '24px',
            }}
          >
            <h3>Edit Lead: {editLead.name}</h3>

            <div style={{ marginBottom: 16 }}>
              <p><strong>Phone:</strong> {editLead.phone || '-'}</p>
              <p><strong>Service Type:</strong> {editLead.service_type || '-'}</p>
              <p><strong>Lead Source:</strong> {editLead.lead_source || '-'}</p>
              <p><strong>Date of Inquiry:</strong> {editLead.date_of_inquiry ? formatDate(editLead.date_of_inquiry) : '-'}</p>
              <p><strong>Date of Estimate:</strong> {editLead.date_of_estimate ? formatDate(editLead.date_of_estimate) : '-'}</p>
            </div>

            <div className="form-group" style={{ marginBottom: 12 }}>
              <label>Status</label>
              <select value={editStatus} onChange={(e) => setEditStatus(e.target.value)} style={{ width: '100%', padding: '8px' }}>
                {STATUS_VALUES.filter((s) => s !== '').map((s) => (
                  <option key={s} value={s}>{statusLabel(s)}</option>
                ))}
              </select>
            </div>

            <div className="form-group" style={{ marginBottom: 12 }}>
              <label>Estimate Amount</label>
              <input
                type="number"
                step="0.01"
                value={editEstimate}
                onChange={(e) => setEditEstimate(e.target.value)}
                style={{ width: '100%', padding: '8px' }}
              />
            </div>

            <div className="form-group" style={{ marginBottom: 12 }}>
              <label>Final Revenue</label>
              <input
                type="number"
                step="0.01"
                value={editRevenue}
                onChange={(e) => setEditRevenue(e.target.value)}
                style={{ width: '100%', padding: '8px' }}
              />
            </div>

            <div className="form-group" style={{ marginBottom: 12 }}>
              <label>Notes</label>
              <textarea
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                rows={3}
                style={{ width: '100%', padding: '8px' }}
              />
            </div>

            {editStatus === 'lost' && (
              <div className="form-group" style={{ marginBottom: 12 }}>
                <label>Loss Reason</label>
                <input
                  value={editLossReason}
                  onChange={(e) => setEditLossReason(e.target.value)}
                  style={{ width: '100%', padding: '8px' }}
                />
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px', marginTop: 16 }}>
              <button
                className="btn-primary"
                onClick={handleSave}
                disabled={updateMut.isPending}
              >
                {updateMut.isPending ? 'Saving...' : 'Save'}
              </button>
              <button className="btn-secondary" onClick={closeEdit}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
