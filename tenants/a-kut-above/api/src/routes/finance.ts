import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { financeService } from '../services/financeService';
import { z } from 'zod';

const router = Router();

// ─── Zod Schemas ────────────────────────────────────────────────────────

const expenseCategoryEnum = z.enum([
  'Equipment',
  'Insurance',
  'Labor',
  'Operations',
  'Credit_Cards',
  'Utilities',
  'Other',
]);

const createIncomeSchema = z.object({
  customer_name: z.string().min(1),
  amount: z.number().positive(),
  date: z.string().min(1),
  job_type: z.string().optional(),
  notes: z.string().optional(),
});

const updateIncomeSchema = z.object({
  customer_name: z.string().min(1).optional(),
  amount: z.number().positive().optional(),
  date: z.string().optional(),
  job_type: z.string().optional(),
  notes: z.string().optional(),
});

const createExpenseSchema = z.object({
  description: z.string().min(1),
  category: expenseCategoryEnum,
  amount: z.number().positive(),
  date: z.string().min(1),
  is_recurring: z.boolean(),
});

const updateExpenseSchema = z.object({
  description: z.string().min(1).optional(),
  category: expenseCategoryEnum.optional(),
  amount: z.number().positive().optional(),
  date: z.string().optional(),
  is_recurring: z.boolean().optional(),
});

const rolloverSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2020),
});

const createDebtSchema = z.object({
  name: z.string().min(1),
  original_amount: z.number().positive(),
  current_balance: z.number().min(0),
  monthly_payment: z.number().min(0),
});

const updateDebtSchema = z.object({
  name: z.string().min(1).optional(),
  original_amount: z.number().positive().optional(),
  current_balance: z.number().min(0).optional(),
  monthly_payment: z.number().min(0).optional(),
});

const createCrewMemberSchema = z.object({
  name: z.string().min(1),
  daily_rate: z.number().positive(),
});

const updateCrewMemberSchema = z.object({
  name: z.string().min(1).optional(),
  daily_rate: z.number().positive().optional(),
  is_active: z.boolean().optional(),
});

const logCrewWorkDaySchema = z.object({
  crew_member_id: z.string().uuid(),
  date: z.string().min(1),
  worked: z.boolean(),
});

const seedDataSchema = z.object({
  income: z.array(z.any()).optional(),
  expenses: z.array(z.any()).optional(),
  debt: z.array(z.any()).optional(),
  crew_members: z.array(z.any()).optional(),
  crew_logs: z.array(z.any()).optional(),
});

// ─── Auth ───────────────────────────────────────────────────────────────

router.use(authenticate);

// ─── INCOME ROUTES ──────────────────────────────────────────────────────

router.get('/income', async (req: AuthRequest, res: Response) => {
  try {
    const month = parseInt(String(req.query.month));
    const year = parseInt(String(req.query.year));
    if (!month || !year) {
      return res.status(400).json({ success: false, error: 'month and year query params required' });
    }
    const data = await financeService.getIncome(month, year);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/income', validate(createIncomeSchema), async (req: AuthRequest, res: Response) => {
  try {
    const data = await financeService.createIncome(req.body);
    res.status(201).json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch('/income/:id', validate(updateIncomeSchema), async (req: AuthRequest, res: Response) => {
  try {
    const data = await financeService.updateIncome(String(req.params.id), req.body);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/income/:id', async (req: AuthRequest, res: Response) => {
  try {
    await financeService.deleteIncome(String(req.params.id));
    res.json({ success: true, data: { deleted: true } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── EXPENSE ROUTES ─────────────────────────────────────────────────────

router.get('/expenses', async (req: AuthRequest, res: Response) => {
  try {
    const month = parseInt(String(req.query.month));
    const year = parseInt(String(req.query.year));
    if (!month || !year) {
      return res.status(400).json({ success: false, error: 'month and year query params required' });
    }
    const data = await financeService.getExpenses(month, year);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/expenses', validate(createExpenseSchema), async (req: AuthRequest, res: Response) => {
  try {
    const data = await financeService.createExpense(req.body);
    res.status(201).json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch('/expenses/:id', validate(updateExpenseSchema), async (req: AuthRequest, res: Response) => {
  try {
    const data = await financeService.updateExpense(String(req.params.id), req.body);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/expenses/:id', async (req: AuthRequest, res: Response) => {
  try {
    await financeService.deleteExpense(String(req.params.id));
    res.json({ success: true, data: { deleted: true } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/expenses/rollover', validate(rolloverSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { month, year } = req.body;
    const data = await financeService.rolloverRecurringExpenses(month, year);
    res.status(201).json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── CUSTOMER ROUTES ────────────────────────────────────────────────────

router.get('/customers', async (_req: AuthRequest, res: Response) => {
  try {
    const data = await financeService.getCustomers();
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/customers/search', async (req: AuthRequest, res: Response) => {
  try {
    const q = String(req.query.q || '');
    if (!q) {
      return res.status(400).json({ success: false, error: 'q query param required' });
    }
    const data = await financeService.searchCustomers(q);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/customers/insights', async (req: AuthRequest, res: Response) => {
  try {
    const year = req.query.year ? parseInt(String(req.query.year)) : undefined;
    const data = await financeService.getCustomerInsights(year);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── DEBT ROUTES ────────────────────────────────────────────────────────

router.get('/debt', async (_req: AuthRequest, res: Response) => {
  try {
    const data = await financeService.getDebts();
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/debt', validate(createDebtSchema), async (req: AuthRequest, res: Response) => {
  try {
    const data = await financeService.createDebt(req.body);
    res.status(201).json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch('/debt/:id', validate(updateDebtSchema), async (req: AuthRequest, res: Response) => {
  try {
    const data = await financeService.updateDebt(String(req.params.id), req.body);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/debt/:id', async (req: AuthRequest, res: Response) => {
  try {
    await financeService.deleteDebt(String(req.params.id));
    res.json({ success: true, data: { deleted: true } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── CREW ROUTES ────────────────────────────────────────────────────────

router.get('/crew', async (_req: AuthRequest, res: Response) => {
  try {
    const data = await financeService.getCrewMembers();
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/crew', validate(createCrewMemberSchema), async (req: AuthRequest, res: Response) => {
  try {
    const data = await financeService.createCrewMember(req.body);
    res.status(201).json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch('/crew/:id', validate(updateCrewMemberSchema), async (req: AuthRequest, res: Response) => {
  try {
    const data = await financeService.updateCrewMember(String(req.params.id), req.body);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/crew/log', async (req: AuthRequest, res: Response) => {
  try {
    const month = parseInt(String(req.query.month));
    const year = parseInt(String(req.query.year));
    if (!month || !year) {
      return res.status(400).json({ success: false, error: 'month and year query params required' });
    }
    const data = await financeService.getCrewLog(month, year);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/crew/log', validate(logCrewWorkDaySchema), async (req: AuthRequest, res: Response) => {
  try {
    const data = await financeService.logCrewWorkDay(req.body);
    res.status(201).json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/crew/summary', async (req: AuthRequest, res: Response) => {
  try {
    const month = parseInt(String(req.query.month));
    const year = parseInt(String(req.query.year));
    if (!month || !year) {
      return res.status(400).json({ success: false, error: 'month and year query params required' });
    }
    const data = await financeService.getCrewPaySummary(month, year);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/crew/yearly-summary', async (req: AuthRequest, res: Response) => {
  try {
    const year = parseInt(String(req.query.year));
    if (!year) {
      return res.status(400).json({ success: false, error: 'year query param required' });
    }
    const data = await financeService.getCrewYearlySummary(year);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/crew/:id', async (req: AuthRequest, res: Response) => {
  try {
    const data = await financeService.updateCrewMember(String(req.params.id), { is_active: false });
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── SUMMARY / DASHBOARD ROUTES ────────────────────────────────────────

router.get('/summary', async (req: AuthRequest, res: Response) => {
  try {
    const year = parseInt(String(req.query.year));
    if (!year) {
      return res.status(400).json({ success: false, error: 'year query param required' });
    }
    const data = await financeService.getYearSummary(year);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/summary/monthly', async (req: AuthRequest, res: Response) => {
  try {
    const month = parseInt(String(req.query.month));
    const year = parseInt(String(req.query.year));
    if (!month || !year) {
      return res.status(400).json({ success: false, error: 'month and year query params required' });
    }
    const data = await financeService.getMonthlySummary(month, year);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── YEAR-END REPORT ────────────────────────────────────────────────────

router.get('/report/year-end', async (req: AuthRequest, res: Response) => {
  try {
    const year = parseInt(String(req.query.year));
    if (!year) {
      return res.status(400).json({ success: false, error: 'year query param required' });
    }
    const data = await financeService.getYearEndReport(year);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── SEED DATA ──────────────────────────────────────────────────────────

router.post('/seed', validate(seedDataSchema), async (req: AuthRequest, res: Response) => {
  try {
    const data = await financeService.seedData(req.body);
    res.status(201).json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
