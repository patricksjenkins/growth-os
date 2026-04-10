import { supabase } from '../config/supabase';
import { smsService } from './smsService';
import { contentService } from './contentService';

export const automationService = {
  // Process follow-ups for leads with status 'estimate_given'
  async processFollowUps() {
    const { data: leads } = await supabase
      .from('leads')
      .select('id, phone, date_of_estimate, status')
      .eq('status', 'estimate_given');

    if (!leads) return [];

    const results = [];

    for (const lead of leads) {
      if (!lead.date_of_estimate || !lead.phone) continue;

      const estimateDate = new Date(lead.date_of_estimate);
      const now = new Date();
      const daysSinceEstimate = Math.floor((now.getTime() - estimateDate.getTime()) / (1000 * 60 * 60 * 24));

      // Check what follow-ups have already been sent
      const { data: logs } = await supabase
        .from('automation_logs')
        .select('step')
        .eq('lead_id', lead.id)
        .eq('automation_type', 'follow_up')
        .eq('status', 'sent');

      const sentSteps = new Set((logs || []).map(l => l.step));

      // Day 2 follow-up
      if (daysSinceEstimate >= 2 && !sentSteps.has(1)) {
        const result = await smsService.sendFollowUp(lead.phone, lead.id, 1);
        results.push({ leadId: lead.id, step: 1, ...result });
      }
      // Day 5 follow-up
      else if (daysSinceEstimate >= 5 && !sentSteps.has(2)) {
        const result = await smsService.sendFollowUp(lead.phone, lead.id, 2);
        results.push({ leadId: lead.id, step: 2, ...result });
      }
      // Day 10 follow-up
      else if (daysSinceEstimate >= 10 && !sentSteps.has(3)) {
        const result = await smsService.sendFollowUp(lead.phone, lead.id, 3);
        results.push({ leadId: lead.id, step: 3, ...result });
      }
    }

    return results;
  },

  // Process review requests for won jobs
  async processReviewRequests() {
    const { data: leads } = await supabase
      .from('leads')
      .select('id, phone, updated_at')
      .eq('status', 'won');

    if (!leads) return [];

    const results = [];

    for (const lead of leads) {
      if (!lead.phone) continue;

      const wonDate = new Date(lead.updated_at);
      const now = new Date();
      const daysSinceWon = Math.floor((now.getTime() - wonDate.getTime()) / (1000 * 60 * 60 * 24));

      if (daysSinceWon < 1 || daysSinceWon > 3) continue;

      // Check if already sent
      const { data: logs } = await supabase
        .from('automation_logs')
        .select('id')
        .eq('lead_id', lead.id)
        .eq('automation_type', 'review_request')
        .eq('status', 'sent');

      if (logs && logs.length > 0) continue;

      const result = await smsService.sendReviewRequest(lead.phone, lead.id);
      results.push({ leadId: lead.id, ...result });
    }

    return results;
  },

  // Process referral requests after completed jobs
  async processReferralRequests() {
    const { data: leads } = await supabase
      .from('leads')
      .select('id, phone, updated_at')
      .eq('status', 'won');

    if (!leads) return [];

    const results = [];

    for (const lead of leads) {
      if (!lead.phone) continue;

      const wonDate = new Date(lead.updated_at);
      const now = new Date();
      const daysSinceWon = Math.floor((now.getTime() - wonDate.getTime()) / (1000 * 60 * 60 * 24));

      if (daysSinceWon < 3 || daysSinceWon > 7) continue;

      const { data: logs } = await supabase
        .from('automation_logs')
        .select('id')
        .eq('lead_id', lead.id)
        .eq('automation_type', 'referral_request')
        .eq('status', 'sent');

      if (logs && logs.length > 0) continue;

      const result = await smsService.sendReferralRequest(lead.phone, lead.id);
      results.push({ leadId: lead.id, ...result });
    }

    return results;
  },

  // Auto-generate content from completed jobs with photos
  async processContentGeneration() {
    return contentService.autoGenerateFromCompletedJobs();
  },
};
