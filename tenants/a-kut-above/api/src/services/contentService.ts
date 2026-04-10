import { supabase } from '../config/supabase';
import { aiService } from './aiService';
import { jobService } from './jobService';
import { socialPublisher } from './socialPublisher';

export const contentService = {
  async generateSocialDraft(leadId: string, variation: boolean = false) {
    const { data: lead } = await supabase
      .from('leads')
      .select('*, job_photos(*)')
      .eq('id', leadId)
      .single();

    if (!lead) throw new Error('Lead not found');

    const photos = lead.job_photos || [];
    const beforePhoto = photos.find((p: any) => p.photo_type === 'before');
    const afterPhoto = photos.find((p: any) => p.photo_type === 'after');

    const postBody = await aiService.generateSocialPost(
      lead.service_type,
      beforePhoto?.public_url,
      afterPhoto?.public_url,
      lead.notes,
      variation
    );

    const imageUrls = [beforePhoto?.public_url, afterPhoto?.public_url].filter(Boolean);

    const { data: draft, error } = await supabase
      .from('content_drafts')
      .insert({
        lead_id: leadId,
        content_type: 'social_post',
        platform: 'facebook',
        title: `${lead.service_type.replace(/_/g, ' ')} - ${lead.name}`,
        body: postBody,
        image_urls: imageUrls,
        status: 'draft',
      })
      .select()
      .single();

    if (error) throw error;
    return draft;
  },

  async getDrafts(status?: string) {
    let query = supabase
      .from('content_drafts')
      .select('*')
      .order('created_at', { ascending: false });

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;
    return data;
  },

  async approveDraft(draftId: string, userId: string) {
    const { data: draft, error } = await supabase
      .from('content_drafts')
      .update({ status: 'approved', approved_by: userId })
      .eq('id', draftId)
      .select()
      .single();

    if (error) throw error;

    // Publish to social media
    if (draft) {
      try {
        const results = await socialPublisher.publish(draft);

        // Mark as published if Buffer succeeded
        if (results.buffer) {
          await supabase
            .from('content_drafts')
            .update({ status: 'published' })
            .eq('id', draftId);
          draft.status = 'published';
        }

        console.log('Social publish results:', results);
      } catch (e) {
        console.error('Social publishing failed:', e);
        // Draft stays as approved even if publishing fails
      }
    }

    return draft;
  },

  async rejectDraft(draftId: string) {
    // Get the original draft to know which lead it belongs to
    const { data: original, error: fetchError } = await supabase
      .from('content_drafts')
      .select('*')
      .eq('id', draftId)
      .single();

    if (fetchError) throw fetchError;

    // Mark old draft as rejected
    await supabase
      .from('content_drafts')
      .update({ status: 'rejected' })
      .eq('id', draftId);

    // Auto-regenerate a new draft with different tone
    if (original?.lead_id) {
      try {
        const newDraft = await this.generateSocialDraft(original.lead_id, true);
        return newDraft; // Return the new draft so the app shows it
      } catch (e) {
        console.error('Failed to regenerate draft after rejection:', e);
        return original; // Fall back to returning the rejected one
      }
    }

    return original;
  },

  async autoGenerateFromCompletedJobs() {
    const pairs = await jobService.getBeforeAfterPairs();

    // Find jobs that don't already have content drafts
    const { data: existingDrafts } = await supabase
      .from('content_drafts')
      .select('lead_id');

    const existingLeadIds = new Set((existingDrafts || []).map(d => d.lead_id));
    const newJobs = pairs.filter(p => !existingLeadIds.has(p.id));

    const drafts = [];
    for (const job of newJobs) {
      try {
        const draft = await this.generateSocialDraft(job.id);
        drafts.push(draft);
      } catch (e) {
        console.error(`Failed to generate draft for job ${job.id}:`, e);
      }
    }

    return drafts;
  },
};
