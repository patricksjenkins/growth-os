import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const instantlyApiKey = process.env.INSTANTLY_API_KEY

const supabase = createClient(supabaseUrl, supabaseServiceKey)

/**
 * API route to stop/pause an email outreach campaign
 * POST /api/stop-sequence
 *
 * Body:
 * {
 *   lead_id: number
 * }
 *
 * Actions:
 * 1. Finds the active outreach campaign for the lead
 * 2. Calls Instantly.ai API to pause the campaign
 * 3. Updates outreach_campaign status to 'paused' in Supabase
 * 4. Returns success response
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { lead_id } = req.body

    if (!lead_id) {
      return res.status(400).json({ error: 'Missing lead_id' })
    }

    // Get the active campaign for this lead
    const { data: campaign, error: campaignError } = await supabase
      .from('outreach_campaigns')
      .select('*')
      .eq('lead_id', lead_id)
      .eq('status', 'active')
      .single()

    if (campaignError || !campaign) {
      return res.status(404).json({ error: 'No active campaign found for this lead' })
    }

    // Call Instantly.ai API to stop the campaign
    if (campaign.instantly_campaign_id && instantlyApiKey) {
      try {
        const instantlyResponse = await fetch(
          `https://api.instantly.ai/api/v1/campaign/${campaign.instantly_campaign_id}/pause`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${instantlyApiKey}`,
              'Content-Type': 'application/json'
            }
          }
        )

        if (!instantlyResponse.ok) {
          console.warn('Instantly.ai API warning:', await instantlyResponse.text())
        }
      } catch (error) {
        console.error('Error calling Instantly.ai:', error)
        // Continue anyway - update Supabase record
      }
    }

    // Update campaign status in Supabase
    const { error: updateError } = await supabase
      .from('outreach_campaigns')
      .update({
        status: 'paused',
        paused_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', campaign.id)

    if (updateError) throw updateError

    // Also update the lead status to indicate sequence is stopped
    const { error: leadError } = await supabase
      .from('leads')
      .update({
        status: 'sequence_paused',
        updated_at: new Date().toISOString()
      })
      .eq('id', lead_id)

    if (leadError) {
      console.warn('Error updating lead status:', leadError)
    }

    return res.status(200).json({
      success: true,
      campaign_id: campaign.id,
      message: 'Outreach sequence stopped'
    })
  } catch (error) {
    console.error('Error in stop-sequence:', error)
    return res.status(500).json({
      error: error.message || 'Internal server error'
    })
  }
}
