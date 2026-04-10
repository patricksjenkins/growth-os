/**
 * Supabase Database Module
 * Provides database access and helper functions for WellMor growth agents
 */

const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * Fetch company by ID with associated contacts
 * @param {string} companyId - Company ID
 * @returns {Promise<Object>} Company object with contacts array
 */
async function getCompany(companyId) {
  try {
    const { data: company, error } = await supabase
      .from('companies')
      .select('*, contacts(*)')
      .eq('id', companyId)
      .single();

    if (error) throw error;
    return company;
  } catch (error) {
    console.error(`Error fetching company ${companyId}:`, error.message);
    throw error;
  }
}

/**
 * Fetch lead with associated company, contacts, and email history
 * @param {string} leadId - Lead ID
 * @returns {Promise<Object>} Lead object with company, contacts, and emails
 */
async function getLeadWithDetails(leadId) {
  try {
    const { data: lead, error } = await supabase
      .from('leads')
      .select(`
        *,
        company:company_id(*),
        contacts(id, name, email, title, phone),
        emails:lead_emails(*)
      `)
      .eq('id', leadId)
      .single();

    if (error) throw error;
    return lead;
  } catch (error) {
    console.error(`Error fetching lead ${leadId}:`, error.message);
    throw error;
  }
}

/**
 * Update lead status
 * @param {string} leadId - Lead ID
 * @param {string} status - New status
 * @returns {Promise<Object>} Updated lead object
 */
async function updateLeadStatus(leadId, status) {
  try {
    const { data, error } = await supabase
      .from('leads')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', leadId)
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error(`Error updating lead ${leadId} status:`, error.message);
    throw error;
  }
}

/**
 * Create activity log entry
 * @param {string} agentName - Name of agent performing action
 * @param {string} action - Action performed
 * @param {string} entityType - Type of entity (company, lead, contact)
 * @param {string} entityId - ID of entity
 * @param {Object} data - Additional data to store as JSON
 * @returns {Promise<Object>} Created activity log entry
 */
async function createActivityLog(agentName, action, entityType, entityId, data = {}) {
  try {
    const { data: log, error } = await supabase
      .from('agent_activity_log')
      .insert([
        {
          agent_name: agentName,
          action,
          entity_type: entityType,
          entity_id: entityId,
          data: data,
          created_at: new Date().toISOString()
        }
      ])
      .select()
      .single();

    if (error) throw error;
    return log;
  } catch (error) {
    console.error(`Error creating activity log:`, error.message);
    throw error;
  }
}

/**
 * Fetch system configuration value
 * @param {string} key - Configuration key
 * @returns {Promise<any>} Configuration value
 */
async function getSystemConfig(key) {
  try {
    const { data, error } = await supabase
      .from('system_config')
      .select('value')
      .eq('key', key)
      .single();

    if (error) throw error;
    return data?.value;
  } catch (error) {
    console.error(`Error fetching system config ${key}:`, error.message);
    return null;
  }
}

/**
 * Fetch pending tasks of a specific type
 * @param {string} taskType - Type of task (prospecting, enrichment, scoring, outreach)
 * @param {number} limit - Maximum number of tasks to fetch
 * @returns {Promise<Array>} Array of pending tasks
 */
async function getPendingTasks(taskType, limit = 10) {
  try {
    const { data, error } = await supabase
      .from('pending_tasks')
      .select('*')
      .eq('task_type', taskType)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error(`Error fetching pending tasks:`, error.message);
    return [];
  }
}

/**
 * Mark task as completed
 * @param {string} taskId - Task ID
 * @param {Object} result - Task result data
 * @returns {Promise<Object>} Updated task object
 */
async function completeTask(taskId, result = {}) {
  try {
    const { data, error } = await supabase
      .from('pending_tasks')
      .update({
        status: 'completed',
        result: result,
        completed_at: new Date().toISOString()
      })
      .eq('id', taskId)
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error(`Error completing task ${taskId}:`, error.message);
    throw error;
  }
}

/**
 * Mark task as failed
 * @param {string} taskId - Task ID
 * @param {string} errorMessage - Error description
 * @returns {Promise<Object>} Updated task object
 */
async function failTask(taskId, errorMessage) {
  try {
    const { data, error } = await supabase
      .from('pending_tasks')
      .update({
        status: 'failed',
        error: errorMessage,
        completed_at: new Date().toISOString()
      })
      .eq('id', taskId)
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error(`Error failing task ${taskId}:`, error.message);
    throw error;
  }
}

/**
 * Upsert a system configuration value.
 * Used for format rotation counter and other persistent state.
 * @param {string} key - Configuration key
 * @param {any} value - Configuration value (stored as JSONB)
 * @param {string} [description] - Optional description
 * @returns {Promise<Object>} Upserted row
 */
async function upsertSystemConfig(key, value, description = null) {
  try {
    const row = { key, value, updated_at: new Date().toISOString() };
    if (description) row.description = description;

    const { data, error } = await supabase
      .from('system_config')
      .upsert(row, { onConflict: 'key' })
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error(`Error upserting system config ${key}:`, error.message);
    throw error;
  }
}

module.exports = {
  supabase,
  getCompany,
  getLeadWithDetails,
  updateLeadStatus,
  createActivityLog,
  getSystemConfig,
  upsertSystemConfig,
  getPendingTasks,
  completeTask,
  failTask
};
