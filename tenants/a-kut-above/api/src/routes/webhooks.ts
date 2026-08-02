import { Router, Request, Response } from 'express';
import { leadService } from '../services/leadService';
import { automationService } from '../services/automationService';
import { outreachService } from '../services/outreachService';

const router = Router();

// Carrier webhook for missed calls
router.post('/telnyx/missed-call', async (req: Request, res: Response) => {
  try {
    const { From, CallStatus } = req.body;

    if (CallStatus === 'no-answer' || CallStatus === 'busy') {
      // Create lead from missed call
      await leadService.create({
        name: 'Missed Call',
        phone: From,
        service_type: 'tree_removal',
        lead_source: 'missed_call_text_back',
        notes: `Missed call - ${CallStatus}`,
      }, 'system');

      // Speed-to-lead SMS is automatically triggered in leadService.create
    }

    res.status(200).send('<Response></Response>');
  } catch (error: any) {
    console.error('Missed call webhook error:', error);
    res.status(200).send('<Response></Response>');
  }
});

// n8n webhook triggers
router.post('/n8n/process-follow-ups', async (_req: Request, res: Response) => {
  try {
    const results = await automationService.processFollowUps();
    res.json({ success: true, processed: results.length, results });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/n8n/process-reviews', async (_req: Request, res: Response) => {
  try {
    const results = await automationService.processReviewRequests();
    res.json({ success: true, processed: results.length, results });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/n8n/process-referrals', async (_req: Request, res: Response) => {
  try {
    const results = await automationService.processReferralRequests();
    res.json({ success: true, processed: results.length, results });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/n8n/process-drip', async (_req: Request, res: Response) => {
  try {
    const contacts = await outreachService.getDueForDrip();
    const results = [];
    for (const contact of contacts) {
      const result = await outreachService.advanceDrip(contact.id);
      if (result) results.push(result);
    }
    res.json({ success: true, processed: results.length, results });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/n8n/process-content', async (_req: Request, res: Response) => {
  try {
    const results = await automationService.processContentGeneration();
    res.json({ success: true, processed: results.length, results });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
