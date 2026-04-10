import { Router, Response } from 'express';
import { authenticate, AuthRequest, requireAdmin } from '../middleware/auth';
import { automationService } from '../services/automationService';

const router = Router();
router.use(authenticate);
router.use(requireAdmin);

router.post('/follow-ups', async (_req: AuthRequest, res: Response) => {
  try {
    const results = await automationService.processFollowUps();
    res.json({ success: true, data: results });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/review-requests', async (_req: AuthRequest, res: Response) => {
  try {
    const results = await automationService.processReviewRequests();
    res.json({ success: true, data: results });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/referral-requests', async (_req: AuthRequest, res: Response) => {
  try {
    const results = await automationService.processReferralRequests();
    res.json({ success: true, data: results });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/content-generation', async (_req: AuthRequest, res: Response) => {
  try {
    const results = await automationService.processContentGeneration();
    res.json({ success: true, data: results });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
