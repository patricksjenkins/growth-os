import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(supabaseUrl, supabaseServiceKey)

/**
 * API route to approve or reject a lead for outreach
 * POST /api/approve-lead
 *
 * Body:
 * {
 *   lead_id: number,
 *   approved: boolean
 * }
 *
 * Approved lead:
 * - Sets outreach_approved = true
 * - Sets status = 'outreach_pending'
 * - Creates pending_task for outreach agent
 *
 * Rejected lead:
 * - Sets outreach_approved = false
 * - Sets status = 'disqualified'
 * - Sets priority_tier = 'C'
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { lead_id, approved } = req.body

    if (!lead_id || typeof approved !== 'boolean') {
      return res.status(400).json({ error: 'Missing or invalid parameters' })
    }

    // Get the lead to check current state
    const { data: lead, error: fetchError } = await supabase
      .from('leads_pipeline_view')
      .select('*')
      .eq('id', lead_id)
      .single()

    if (fetchError) throw fetchError
    if (!lead) return res.status(404).json({ error: 'Lead not found' })

    if (approved) {
      // Approve the lead
      const { error: updateError } = await supabase
        .from('leads')
        .update({
          outreach_approved: true,
          status: 'outreach_pending',
          updated_at: new Date().toISOString()
        })
        .eq('id', lead_id)

      if (updateError) throw updateError

      // Create pending task for outreach agent
      const { error: taskError } = await supabase
        .from('pending_tasks')
        .insert({
          lead_id,
          task_type: 'start_outreach',
          status: 'pending',
          created_at: new Date().toISOString(),
          metadata: {
            company_name: lead.company_name,
            tier: lead.priority_tier,
            outreach_angle: lead.outreach_angle
          }
        })

      if (taskError) {
        console.error('Error creating task, but lead was approved:', taskError)
      }

      return res.status(200).json({
        success: true,
        lead_id,
        status: 'approved'
      })
    } else {
      // Reject the lead
      const { error: updateError } = await supabase
        .from('leads')
        .update({
          outreach_approved: false,
          status: 'disqualified',
          priority_tier: 'C',
          updated_at: new Date().toISOString()
        })
        .eq('id', lead_id)

      if (updateError) throw updateError

      return res.status(200).json({
        success: true,
        lead_id,
        status: 'rejected'
      })
    }
  } catch (error) {
    console.error('Error in approve-lead:', error)
    return res.status(500).json({
      error: error.message || 'Internal server error'
    })
  }
}
