import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { leadService } from '../services/leadService';
import { z } from 'zod';

const router = Router();

const serviceTypeEnum = z.enum(['tree_removal', 'trimming', 'stump_grinding', 'storm_cleanup', 'emergency_removal', 'debris_haul_off']);

const createLeadSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(10),
  service_type: serviceTypeEnum.optional(),
  service_types: z.array(serviceTypeEnum).min(1, 'Select at least one service type'),
  lead_source: z.enum(['google_search', 'google_ads', 'facebook', 'instagram', 'website', 'referral_past_customer', 'referral_realtor', 'referral_insurance_agent', 'word_of_mouth', 'yard_sign', 'repeat_customer', 'missed_call_text_back', 'homeadvisor', 'other']),
  notes: z.string().optional(),
});

const updateLeadSchema = z.object({
  status: z.enum(['new_lead', 'estimate_given', 'won', 'lost', 'completed']).optional(),
  date_of_estimate: z.string().optional(),
  estimate_amount: z.number().optional(),
  final_revenue: z.number().optional(),
  loss_reason: z.enum(['too_expensive', 'chose_competitor', 'no_response', 'delayed_decision', 'out_of_area', 'bad_lead']).optional(),
  notes: z.string().optional(),
});

router.use(authenticate);

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status, lead_source, limit, offset } = req.query;
    const result = await leadService.getAll({
      status: status as any,
      lead_source: lead_source as string,
      limit: limit ? parseInt(String(limit)) : undefined,
      offset: offset ? parseInt(String(offset)) : undefined,
    });
    res.json({ success: true, data: result.leads, count: result.count });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const lead = await leadService.getById(String(req.params.id));
    res.json({ success: true, data: lead });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/', validate(createLeadSchema), async (req: AuthRequest, res: Response) => {
  try {
    const lead = await leadService.create(req.body, req.user!.id);
    res.status(201).json({ success: true, data: lead });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch('/:id', validate(updateLeadSchema), async (req: AuthRequest, res: Response) => {
  try {
    const lead = await leadService.update(String(req.params.id), req.body);
    res.json({ success: true, data: lead });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
