/**
 * Agent Jobs & Idempotency Queries
 */

const { db } = require('../client');

/**
 * Enqueue a job for the worker
 */
async function enqueueJob(tenantId, agentName, payload = {}, options = {}) {
  const { data, error } = await db
    .from('agent_jobs')
    .insert({
      tenant_id: tenantId,
      agent_name: agentName,
      payload,
      status: 'pending',
      priority: options.priority || 0,
      scheduled_for: options.scheduledFor || null
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Get pending jobs (for worker processor)
 */
async function getPendingJobs(limit = 5) {
  const { data, error } = await db
    .from('agent_jobs')
    .select('*')
    .eq('status', 'pending')
    .or('scheduled_for.is.null,scheduled_for.lte.' + new Date().toISOString())
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

/**
 * Mark job as processing
 */
async function markProcessing(jobId) {
  const { error } = await db
    .from('agent_jobs')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'pending'); // Only if still pending
  if (error) throw error;
}

/**
 * Mark job completed
 */
async function markCompleted(jobId, result = null) {
  const { error } = await db
    .from('agent_jobs')
    .update({
      status: 'completed',
      result,
      completed_at: new Date().toISOString()
    })
    .eq('id', jobId);
  if (error) throw error;
}

/**
 * Mark job failed
 */
async function markFailed(jobId, errorMsg) {
  const { error } = await db
    .from('agent_jobs')
    .update({
      status: 'failed',
      error: errorMsg,
      completed_at: new Date().toISOString()
    })
    .eq('id', jobId);
  if (error) throw error;
}

/**
 * Log agent activity
 */
async function logActivity(tenantId, agentName, action, details = {}) {
  const startTime = details._startTime;
  const durationMs = startTime ? Date.now() - startTime : null;

  await db.from('agent_activity_log').insert({
    tenant_id: tenantId,
    agent_name: agentName,
    action,
    status: details.status || 'success',
    records_affected: details.recordsAffected || 0,
    duration_ms: durationMs,
    details: details.data || {},
    error: details.error || null
  });
}

/**
 * Check idempotency — returns cached result if action already performed
 */
async function checkIdempotency(tenantId, key) {
  const { data } = await db
    .from('idempotency_keys')
    .select('result')
    .eq('tenant_id', tenantId)
    .eq('key', key)
    .single();
  return data?.result || null;
}

/**
 * Record idempotency — cache result for future checks
 */
async function recordIdempotency(tenantId, key, action, result) {
  await db.from('idempotency_keys').insert({
    tenant_id: tenantId,
    key,
    action,
    result,
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  });
}

module.exports = {
  enqueueJob,
  getPendingJobs,
  markProcessing,
  markCompleted,
  markFailed,
  logActivity,
  checkIdempotency,
  recordIdempotency
};
