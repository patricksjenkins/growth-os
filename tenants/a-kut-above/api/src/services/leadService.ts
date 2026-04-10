import { supabase } from '../config/supabase';
import { Lead, LeadStatus } from '../types';
import { smsService } from './smsService';
import { contentService } from './contentService';

export const leadService = {
  async create(data: Partial<Lead> & { service_types?: string[] }, userId: string) {
    // Set service_type to first item for backward compatibility
    const serviceTypes = data.service_types || (data.service_type ? [data.service_type] : []);
    const { data: lead, error } = await supabase
      .from('leads')
      .insert({
        ...data,
        service_type: serviceTypes[0] || data.service_type,
        service_types: serviceTypes,
        status: 'new_lead',
        date_of_inquiry: new Date().toISOString(),
        created_by: userId,
      })
      .select()
      .single();

    if (error) throw error;

    // Trigger speed-to-lead SMS
    if (lead?.phone) {
      await smsService.sendSpeedToLead(lead.phone, lead.id);
    }

    return lead;
  },

  async getAll(filters?: { status?: LeadStatus; lead_source?: string; limit?: number; offset?: number }) {
    let query = supabase
      .from('leads')
      .select('*, job_photos(*)', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (filters?.status) query = query.eq('status', filters.status);
    if (filters?.lead_source) query = query.eq('lead_source', filters.lead_source);
    if (filters?.limit) query = query.limit(filters.limit);
    if (filters?.offset) query = query.range(filters.offset, filters.offset + (filters.limit || 20) - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    return { leads: data, count };
  },

  async getById(id: string) {
    const { data, error } = await supabase
      .from('leads')
      .select('*, job_photos(*), automation_logs(*)')
      .eq('id', id)
      .single();

    if (error) throw error;
    return data;
  },

  async update(id: string, updates: Partial<Lead>) {
    const { data, error } = await supabase
      .from('leads')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // Trigger automations based on status change
    if (updates.status === 'won' && data?.phone) {
      // Schedule review request (handled by n8n, but we log intent)
      await supabase.from('automation_logs').insert({
        lead_id: id,
        automation_type: 'review_request',
        step: 0,
        status: 'pending',
        message: 'Scheduled for 1-2 days after job completion',
      });
    }

    // Auto-generate social media content when job is completed
    if (updates.status === 'completed') {
      try {
        // Check if lead has before/after photos
        const { data: photos } = await supabase
          .from('job_photos')
          .select('photo_type')
          .eq('lead_id', id);

        const hasBefore = photos?.some(p => p.photo_type === 'before');
        const hasAfter = photos?.some(p => p.photo_type === 'after');

        if (hasBefore && hasAfter) {
          // Check if draft already exists
          const { data: existing } = await supabase
            .from('content_drafts')
            .select('id')
            .eq('lead_id', id)
            .limit(1);

          if (!existing || existing.length === 0) {
            await contentService.generateSocialDraft(id);
            console.log(`Auto-generated content draft for completed job ${id}`);
          }
        }
      } catch (e) {
        console.error('Auto content generation failed:', e);
        // Don't fail the status update if content generation fails
      }
    }

    return data;
  },

  async getTodayCount() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { count } = await supabase
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', today.toISOString());

    return count || 0;
  },

  async getScheduledJobsCount() {
    const { count } = await supabase
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .in('status', ['estimate_given', 'won'])
      .not('date_of_estimate', 'is', null);

    return count || 0;
  },
};
