import { useState } from 'react';
import { useJobs } from '../hooks/useFinance';
import { formatCurrency, formatDate } from '../utils';

interface Job {
  _id?: string;
  id?: number;
  name?: string;
  phone?: string;
  service_type?: string;
  lead_source?: string;
  estimate_amount?: number;
  final_revenue?: number;
  date_of_inquiry?: string;
  date_of_estimate?: string;
  notes?: string;
  status?: string;
}

export default function Jobs() {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useJobs(page);

  const jobs: Job[] = data?.data || [];
  const totalPages = data?.totalPages || data?.pages || 1;

  return (
    <div className="page-jobs">
      <div className="page-header">
        <h2>Jobs</h2>
      </div>

      {isLoading ? (
        <div className="loading">Loading...</div>
      ) : jobs.length === 0 ? (
        <div className="card text-center text-muted" style={{ padding: 32 }}>No jobs found.</div>
      ) : (
        <>
          <div className="card-grid">
            {jobs.map((job, i) => (
              <div key={job._id || job.id || i} className="card job-card">
                <div className="job-card-header">
                  <h3>{job.name || 'Unknown'}</h3>
                  {job.final_revenue != null && (
                    <span className="job-amount">{formatCurrency(job.final_revenue)}</span>
                  )}
                </div>
                <div className="job-meta">
                  {job.date_of_estimate && <span>Date: {formatDate(job.date_of_estimate)}</span>}
                  {job.service_type && <span>Type: {job.service_type}</span>}
                  {job.lead_source && <span>Source: {job.lead_source}</span>}
                  {job.status && (
                    <span className={`status-badge status-${job.status.toLowerCase()}`}>{job.status}</span>
                  )}
                </div>
                {job.notes && <p className="text-muted text-sm">{job.notes}</p>}
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
    </div>
  );
}
