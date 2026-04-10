import { Router, Response } from 'express';
import { authenticate, AuthRequest, requireAdmin } from '../middleware/auth';
import { outreachService } from '../services/outreachService';
import { validate } from '../middleware/validate';
import { z } from 'zod';

const router = Router();
router.use(authenticate);

const addContactSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  company: z.string().optional(),
  contact_type: z.enum(['realtor', 'insurance_agent', 'landscaper', 'contractor']),
  notes: z.string().optional(),
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { contact_type, status } = req.query;
    const contacts = await outreachService.getContacts({
      contact_type: contact_type as string,
      status: status as string,
    });
    res.json({ success: true, data: contacts });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/', validate(addContactSchema), async (req: AuthRequest, res: Response) => {
  try {
    const contact = await outreachService.addContact(req.body);
    res.status(201).json({ success: true, data: contact });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/advance', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const result = await outreachService.advanceDrip(String(req.params.id));
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/due', async (_req: AuthRequest, res: Response) => {
  try {
    const contacts = await outreachService.getDueForDrip();
    res.json({ success: true, data: contacts });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
