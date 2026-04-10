import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { photoService } from '../services/photoService';
import multer from 'multer';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files allowed'));
    }
  },
});

const router = Router();
router.use(authenticate);

router.post('/:leadId/:photoType', upload.single('photo'), async (req: AuthRequest, res: Response) => {
  try {
    const leadId = String(req.params.leadId);
    const photoType = String(req.params.photoType);
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    const validTypes = ['before', 'after', 'extra_1', 'extra_2'];
    if (!validTypes.includes(photoType)) {
      return res.status(400).json({ success: false, error: 'Photo type must be before, after, extra_1, or extra_2' });
    }
    const photo = await photoService.upload(leadId, photoType as any, req.file);
    res.status(201).json({ success: true, data: photo });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/lead/:leadId', async (req: AuthRequest, res: Response) => {
  try {
    const photos = await photoService.getByLead(String(req.params.leadId));
    res.json({ success: true, data: photos });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/', async (_req: AuthRequest, res: Response) => {
  try {
    const photos = await photoService.getAllPhotos();
    res.json({ success: true, data: photos });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/lead/:leadId', async (req: AuthRequest, res: Response) => {
  try {
    await photoService.deleteAllForLead(String(req.params.leadId));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    await photoService.delete(String(req.params.id));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
