import { twilioClient } from '../config/twilio';
import { env } from '../config/env';
import { supabase } from '../config/supabase';

export const smsService = {
  async sendSMS(to: string, body: string, leadId?: string, automationType?: string, step?: number) {
    try {
      const message = await twilioClient.messages.create({
        body,
        from: env.TWILIO_PHONE_NUMBER,
        to,
      });

      // Log the automation
      if (leadId && automationType) {
        await supabase.from('automation_logs').insert({
          lead_id: leadId,
          automation_type: automationType,
          step: step || 1,
          status: 'sent',
          message: body,
          sent_at: new Date().toISOString(),
        });
      }

      return { success: true, sid: message.sid };
    } catch (error: any) {
      console.error('SMS send error:', error.message);

      if (leadId && automationType) {
        await supabase.from('automation_logs').insert({
          lead_id: leadId,
          automation_type: automationType,
          step: step || 1,
          status: 'failed',
          message: error.message,
        });
      }

      return { success: false, error: error.message };
    }
  },

  async sendSpeedToLead(phone: string, leadId: string) {
    const message = `Hey this is A Kut Above — we can get you a free estimate today. When works for you?`;
    return this.sendSMS(phone, message, leadId, 'speed_to_lead', 1);
  },

  async sendFollowUp(phone: string, leadId: string, step: number) {
    const messages: Record<number, string> = {
      1: `Hey, just following up from A Kut Above Tree Service. Still need that estimate? We can come out anytime this week.`,
      2: `Hi again — A Kut Above here. We'd love to help with your tree work. Want us to swing by for a free estimate?`,
      3: `Last check-in from A Kut Above! If you still need tree service, we're here. Just reply and we'll get you on the schedule.`,
    };
    return this.sendSMS(phone, messages[step] || messages[1], leadId, 'follow_up', step);
  },

  async sendReviewRequest(phone: string, leadId: string) {
    const message = `Thanks for choosing A Kut Above! If you're happy with the work, we'd really appreciate a quick Google review — it helps us a ton. ${env.GOOGLE_REVIEW_URL}`;
    return this.sendSMS(phone, message, leadId, 'review_request', 1);
  },

  async sendReferralRequest(phone: string, leadId: string) {
    const message = `Hey, thanks again for trusting A Kut Above! If you know anyone who needs tree work, send them our way — we'd love to help them out too.`;
    return this.sendSMS(phone, message, leadId, 'referral_request', 1);
  },
};
