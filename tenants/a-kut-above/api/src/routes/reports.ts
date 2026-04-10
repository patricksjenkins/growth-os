import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { reportService } from '../services/reportService';

const router = Router();
router.use(authenticate);

router.get('/dashboard', async (_req: AuthRequest, res: Response) => {
  try {
    const dashboard = await reportService.getDashboard();
    res.json({ success: true, data: dashboard });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/leads-by-source', async (req: AuthRequest, res: Response) => {
  try {
    const { period } = req.query;
    const data = await reportService.getLeadsBySource(period as string);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/referral-performance', async (_req: AuthRequest, res: Response) => {
  try {
    const data = await reportService.getReferralPartnerPerformance();
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/missed-call-recovery', async (_req: AuthRequest, res: Response) => {
  try {
    const data = await reportService.getMissedCallRecovery();
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
