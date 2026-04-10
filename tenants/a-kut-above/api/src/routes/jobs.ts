import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { jobService } from '../services/jobService';

const router = Router();
router.use(authenticate);

router.get('/won', async (req: AuthRequest, res: Response) => {
  try {
    const { limit, offset } = req.query;
    const result = await jobService.getWonJobs(
      limit ? parseInt(limit as string) : 20,
      offset ? parseInt(offset as string) : 0
    );
    res.json({ success: true, data: result.jobs, count: result.count });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/with-photos', async (_req: AuthRequest, res: Response) => {
  try {
    const jobs = await jobService.getJobsWithPhotos();
    res.json({ success: true, data: jobs });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/before-after', async (_req: AuthRequest, res: Response) => {
  try {
    const pairs = await jobService.getBeforeAfterPairs();
    res.json({ success: true, data: pairs });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
