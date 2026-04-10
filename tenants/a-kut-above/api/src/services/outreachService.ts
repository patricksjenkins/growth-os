import { supabase } from '../config/supabase';
import { aiService } from './aiService';
import { emailService } from './emailService';
import { OutreachContact } from '../types';

export const outreachService = {
  async addContact(data: Partial<OutreachContact>) {
    const { data: contact, error } = await supabase
      .from('outreach_contacts')
      .insert({
        ...data,
        drip_stage: 0,
        status: 'active',
      })
      .select()
      .single();

    if (error) throw error;
    return contact;
  },

  async getContacts(filters?: { contact_type?: string; status?: string }) {
    let query = supabase
      .from('outreach_contacts')
      .select('*')
      .order('created_at', { ascending: false });

    if (filters?.contact_type) query = query.eq('contact_type', filters.contact_type);
    if (filters?.status) query = query.eq('status', filters.status);

    const { data, error } = await query;
    if (error) throw error;
    return data;
  },

  async advanceDrip(contactId: string) {
    const { data: contact } = await supabase
      .from('outreach_contacts')
      .select('*')
      .eq('id', contactId)
      .single();

    if (!contact || contact.status !== 'active' || contact.drip_stage >= 6) {
      return null;
    }

    const nextStage = contact.drip_stage + 1;

    // Generate email for next stage
    const email = await aiService.generateOutreachEmail(
      contact.contact_type,
      nextStage,
      contact.name,
      contact.company
    );

    // Send email
    await emailService.send(contact.email, email.subject, email.body);

    // Update contact
    const { data: updated, error } = await supabase
      .from('outreach_contacts')
      .update({
        drip_stage: nextStage,
        last_contacted_at: new Date().toISOString(),
        status: nextStage >= 6 ? 'completed' : 'active',
      })
      .eq('id', contactId)
      .select()
      .single();

    if (error) throw error;

    // Log
    await supabase.from('automation_logs').insert({
      automation_type: 'drip_email',
      step: nextStage,
      status: 'sent',
      message: `Drip stage ${nextStage} sent to ${contact.email}`,
    });

    return updated;
  },

  async getDueForDrip() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data, error } = await supabase
      .from('outreach_contacts')
      .select('*')
      .eq('status', 'active')
      .lt('drip_stage', 6)
      .or(`last_contacted_at.is.null,last_contacted_at.lt.${thirtyDaysAgo.toISOString()}`);

    if (error) throw error;
    return data || [];
  },
};
