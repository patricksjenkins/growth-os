// Lead types
export type ServiceType =
  | 'tree_removal'
  | 'trimming'
  | 'stump_grinding'
  | 'storm_cleanup'
  | 'emergency_removal'
  | 'debris_haul_off';

export type LeadSource =
  | 'google_search'
  | 'google_ads'
  | 'facebook'
  | 'instagram'
  | 'website'
  | 'referral_past_customer'
  | 'referral_realtor'
  | 'referral_insurance_agent'
  | 'word_of_mouth'
  | 'yard_sign'
  | 'repeat_customer'
  | 'missed_call_text_back'
  | 'homeadvisor'
  | 'other';

export type LeadStatus = 'new_lead' | 'estimate_given' | 'won' | 'lost' | 'completed';

export type LossReason =
  | 'too_expensive'
  | 'chose_competitor'
  | 'no_response'
  | 'delayed_decision'
  | 'out_of_area'
  | 'bad_lead';

export interface Lead {
  id: string;
  name: string;
  phone: string;
  service_type: ServiceType;
  service_types: ServiceType[];
  lead_source: LeadSource;
  status: LeadStatus;
  date_of_inquiry: string;
  date_of_estimate?: string;
  estimate_amount?: number;
  final_revenue?: number;
  loss_reason?: LossReason;
  notes?: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface JobPhoto {
  id: string;
  lead_id: string;
  photo_type: 'before' | 'after' | 'extra_1' | 'extra_2';
  storage_path: string;
  public_url: string;
  caption?: string;
  created_at: string;
}

export interface OutreachContact {
  id: string;
  name: string;
  email: string;
  phone?: string;
  company?: string;
  contact_type: 'realtor' | 'insurance_agent' | 'landscaper' | 'contractor';
  drip_stage: number; // 0-6
  drip_started_at?: string;
  last_contacted_at?: string;
  status: 'active' | 'paused' | 'completed' | 'unsubscribed';
  notes?: string;
  created_at: string;
}

export interface ContentDraft {
  id: string;
  lead_id?: string;
  content_type: 'social_post' | 'ad_copy' | 'outreach_email';
  platform?: 'facebook' | 'instagram' | 'google_ads';
  title?: string;
  body: string;
  image_urls?: string[];
  status: 'draft' | 'approved' | 'published' | 'rejected';
  approved_by?: string;
  created_at: string;
}

export interface AutomationLog {
  id: string;
  lead_id?: string;
  automation_type: 'speed_to_lead' | 'follow_up' | 'review_request' | 'referral_request' | 'drip_email';
  step: number;
  status: 'sent' | 'failed' | 'pending' | 'skipped';
  message?: string;
  sent_at?: string;
  created_at: string;
}

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: 'admin' | 'standard' | 'crew';
  created_at: string;
}

export type ApiResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
  count?: number;
};

// ─── Finance Types ──────────────────────────────────────────────────────

export type ExpenseCategory =
  | 'Equipment'
  | 'Insurance'
  | 'Labor'
  | 'Operations'
  | 'Credit_Cards'
  | 'Utilities'
  | 'Other';

export interface IncomeEntry {
  id: string;
  customer_name: string;
  amount: number;
  date: string;
  job_type?: string;
  notes?: string;
  created_at: string;
}

export interface ExpenseEntry {
  id: string;
  description: string;
  category: ExpenseCategory;
  amount: number;
  date: string;
  is_recurring: boolean;
  created_at: string;
}

export interface DebtRecord {
  id: string;
  name: string;
  original_amount: number;
  current_balance: number;
  monthly_payment: number;
  created_at: string;
}

export interface DebtWithProgress extends DebtRecord {
  paid_off: number;
  progress_pct: number;
}

export interface CrewMember {
  id: string;
  name: string;
  daily_rate: number;
  is_active: boolean;
  created_at: string;
}

export interface CrewDailyLog {
  id: string;
  crew_member_id: string;
  date: string;
  worked: boolean;
  created_at: string;
}

export interface CrewPaySummaryEntry {
  id: string;
  name: string;
  daily_rate: number;
  days_worked: number;
  total_pay: number;
}

export interface CrewPaySummary {
  crew: CrewPaySummaryEntry[];
  grand_total: number;
}

export interface CustomerProfile {
  customer_name: string;
  total_revenue: number;
  job_count: number;
  first_job: string;
  last_job: string;
  job_types: string[];
  is_repeat: boolean;
}

export interface CustomerInsights {
  total_customers: number;
  repeat_customers: number;
  repeat_rate: number;
  repeat_revenue: number;
  new_customer_revenue: number;
  top_customers: {
    customer_name: string;
    job_count: number;
    total_revenue: number;
  }[];
}

export interface MonthlyBreakdown {
  income: number;
  expenses: number;
  net: number;
}

export interface YearSummary {
  year: number;
  total_income: number;
  total_expenses: number;
  net_profit: number;
  monthly_breakdown: Record<number, MonthlyBreakdown>;
}

export interface MonthlySummary {
  month: number;
  year: number;
  total_income: number;
  total_expenses: number;
  net_profit: number;
  income_entries: IncomeEntry[];
  expense_entries: ExpenseEntry[];
  expenses_by_category: Record<string, number>;
}

export interface YearEndReport {
  year: number;
  total_income: number;
  total_expenses: number;
  net_profit: number;
  profit_margin: number;
  expenses_by_category: Record<string, number>;
  monthly_breakdown: Record<number, MonthlyBreakdown>;
  income_entries: IncomeEntry[];
  expense_entries: ExpenseEntry[];
}
