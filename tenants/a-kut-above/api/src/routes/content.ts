import { Router, Response } from 'express';
import { authenticate, AuthRequest, requireAdmin } from '../middleware/auth';
import { contentService } from '../services/contentService';
import { socialPublisher } from '../services/socialPublisher';

const router = Router();
router.use(authenticate);

router.get('/drafts', async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.query;
    const drafts = await contentService.getDrafts(status as string);
    res.json({ success: true, data: drafts });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/generate/:leadId', async (req: AuthRequest, res: Response) => {
  try {
    const draft = await contentService.generateSocialDraft(String(req.params.leadId));
    res.status(201).json({ success: true, data: draft });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/drafts/:id/approve', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const draft = await contentService.approveDraft(String(req.params.id), req.user!.id);
    res.json({ success: true, data: draft });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/drafts/:id/reject', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const draft = await contentService.rejectDraft(String(req.params.id));
    res.json({ success: true, data: draft });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/auto-generate', requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const drafts = await contentService.autoGenerateFromCompletedJobs();
    res.json({ success: true, data: drafts, count: drafts.length });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get Buffer channels (for setup - find your channel ID)
router.get('/channels', requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const channels = await socialPublisher.getChannels();
    res.json({ success: true, data: channels });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
