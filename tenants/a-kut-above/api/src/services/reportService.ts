import { supabase } from '../config/supabase';

export const reportService = {
  async getDashboard() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      { count: newLeadsToday },
      { count: totalLeads },
      { data: statusCounts },
      { data: revenueData },
    ] = await Promise.all([
      supabase.from('leads').select('*', { count: 'exact', head: true }).gte('created_at', today.toISOString()),
      supabase.from('leads').select('*', { count: 'exact', head: true }),
      supabase.from('leads').select('status'),
      supabase.from('leads').select('final_revenue, status').eq('status', 'completed'),
    ]);

    const completed = (statusCounts || []).filter(l => l.status === 'completed').length;
    const won = (statusCounts || []).filter(l => l.status === 'won').length;
    const lost = (statusCounts || []).filter(l => l.status === 'lost').length;
    const totalSuccess = completed + won;
    const conversionRate = (totalSuccess + lost) > 0 ? Math.round((totalSuccess / (totalSuccess + lost)) * 100) : 0;
    const totalRevenue = (revenueData || []).reduce((sum, l) => sum + (l.final_revenue || 0), 0);

    const scheduledJobs = (statusCounts || []).filter(l => l.status === 'estimate_given').length;

    return {
      newLeadsToday: newLeadsToday || 0,
      totalLeads: totalLeads || 0,
      jobsScheduled: scheduledJobs,
      conversionRate,
      totalRevenue,
      wonJobs: completed,
      lostJobs: lost,
    };
  },

  async getLeadsBySource(period?: string) {
    let query = supabase
      .from('leads')
      .select('lead_source, status, final_revenue, created_at');

    if (period) {
      const now = new Date();
      let startDate: Date;
      if (period === 'this_month') {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      } else if (period === 'last_month') {
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const endDate = new Date(now.getFullYear(), now.getMonth(), 1);
        query = query.lt('created_at', endDate.toISOString());
      } else if (period === 'this_year') {
        startDate = new Date(now.getFullYear(), 0, 1);
      } else {
        startDate = new Date(0); // all time
      }
      query = query.gte('created_at', startDate!.toISOString());
    }

    const { data, error } = await query;

    if (error) throw error;

    const bySource: Record<string, { total: number; won: number; lost: number; revenue: number }> = {};

    for (const lead of data || []) {
      if (!bySource[lead.lead_source]) {
        bySource[lead.lead_source] = { total: 0, won: 0, lost: 0, revenue: 0 };
      }
      bySource[lead.lead_source].total++;
      if (lead.status === 'won' || lead.status === 'completed') {
        bySource[lead.lead_source].won++;
        bySource[lead.lead_source].revenue += lead.final_revenue || 0;
      }
      if (lead.status === 'lost') bySource[lead.lead_source].lost++;
    }

    return bySource;
  },

  async getReferralPartnerPerformance() {
    const { data, error } = await supabase
      .from('outreach_contacts')
      .select('*');

    if (error) throw error;

    // Get leads from referral sources
    const { data: referralLeads } = await supabase
      .from('leads')
      .select('lead_source, status, final_revenue')
      .in('lead_source', ['referral_realtor', 'referral_insurance_agent']);

    return {
      contacts: data || [],
      referralLeads: referralLeads || [],
      totalReferralRevenue: (referralLeads || [])
        .filter(l => l.status === 'won' || l.status === 'completed')
        .reduce((sum, l) => sum + (l.final_revenue || 0), 0),
    };
  },

  async getMissedCallRecovery() {
    const { data, error } = await supabase
      .from('leads')
      .select('status, final_revenue')
      .eq('lead_source', 'missed_call_text_back');

    if (error) throw error;

    const total = data?.length || 0;
    const converted = data?.filter(l => l.status === 'won' || l.status === 'completed').length || 0;
    const revenue = data?.filter(l => l.status === 'won' || l.status === 'completed').reduce((sum, l) => sum + (l.final_revenue || 0), 0) || 0;

    return {
      totalMissedCallLeads: total,
      converted,
      conversionRate: total > 0 ? Math.round((converted / total) * 100) : 0,
      revenue,
    };
  },
};
