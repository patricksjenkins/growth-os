import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Support both ESM and CJS execution
const scriptDir = typeof __dirname !== 'undefined'
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(scriptDir, '..', '.env') });

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://fogmqtnvmwahkmngmkds.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'SERVICE_KEY_HERE'
);

// ─── Types ──────────────────────────────────────────────────────────────

type ExpenseCategory = 'Equipment' | 'Insurance' | 'Labor' | 'Operations' | 'Credit_Cards' | 'Utilities' | 'Other';

interface IncomeRow {
  customer_name: string;
  amount: number;
  date: string;
  job_type: string;
}

interface ExpenseRow {
  description: string;
  category: ExpenseCategory;
  amount: number;
  date: string;
  is_recurring: boolean;
}

interface DebtRow {
  name: string;
  original_amount: number;
  current_balance: number;
  monthly_payment: number;
}

interface CrewMemberRow {
  name: string;
  daily_rate: number;
  is_active: boolean;
}

// ─── Helper: date for the 15th of a given month/year ────────────────────

function d(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-15`;
}

// ─── Category classifier ────────────────────────────────────────────────

function categorize(desc: string): { category: ExpenseCategory; is_recurring: boolean } {
  const d = desc.toLowerCase();

  // Equipment
  if (d.includes('skid steer') || d.includes('spider lift') || d.includes('m&m spider') ||
      d.includes('ford 2020') || d.includes('chevy 2020') || d.includes('trailer 20ft') ||
      d.includes('trailer 16ft') || d.includes('stump grinder') || d.includes('toyota') ||
      d.includes('nfcu') || d.includes('kubota') || d.includes('tractor') ||
      d.includes('dump truck') || d.includes('2009 chevy') || d.includes('hancock bank') ||
      d.includes('hancock loan') || d.includes('veermer') || d.includes('cannon ford') ||
      d.includes('mullinax') || d.includes('drive shaft'))
    return { category: 'Equipment', is_recurring: d.includes('payment') || d.includes('grinder') || d.includes('nfcu') || d.includes('toyota') || d.includes('hancock bank') || d.includes('hancock loan') };

  // Insurance
  if (d.includes('state farm') || d.includes('burlington') || d.includes('stonemark') ||
      d.includes('ipfs') || d.includes('building insurance') || d.includes('hardy') ||
      d.includes('jacobson') || d.includes('liability ins') || d.includes('coastal ins'))
    return { category: 'Insurance', is_recurring: true };

  // Labor
  if (d.includes('foreman') || d.includes('dale') || d.includes('groundcrew') ||
      d.includes('ground crew') || d.includes('amy') || d.includes('daniel') ||
      d.includes('darrell') || d.includes('lizzy') || d.includes('bryer') ||
      d.includes('hauler') || d.includes('john w') || d.includes('payroll') ||
      d.includes('bonus') || d.includes('reimbursement') || d.includes('jarred') ||
      d.includes('tori') || d.includes('andrew') || d.includes('dennis') ||
      d.includes('dale tait') || d.includes('b haas'))
    return { category: 'Labor', is_recurring: false };

  // Utilities
  if (d.includes('centurylink') || d.includes('at&t') || d.includes('internet') ||
      d.includes('cell phone') || d.includes('ms power') || d.includes('water bill') ||
      d.includes('city of m') || d.includes('mp water') || d.includes('coastal alarm') ||
      d.includes('alarm'))
    return { category: 'Utilities', is_recurring: true };

  // Credit Cards
  if (d.includes('mastercard') || d.includes('amex') || d.includes('american express') ||
      d.includes('regions cc') || d.includes('regions c c') || d.includes('regions credit') ||
      d.includes('regions loc') || d.includes('regions line') || d.includes('regions 2600') ||
      d.includes('regions account') || d.includes('wells fargo') || d.includes('l.l. bean') ||
      d.includes('discover') || d.includes('hancock c c') || d.includes('hancock cc') ||
      d.includes('hancock loc') || d.includes('hancock line'))
    return { category: 'Credit_Cards', is_recurring: true };

  // Operations
  if (d.includes('dump') || d.includes('fuel') || d.includes('tires') || d.includes('jim') ||
      d.includes('delta world') || d.includes('rope') || d.includes('tag') ||
      d.includes('tax collector') || d.includes('tax revenue') || d.includes('cpa') ||
      d.includes('privilege') || d.includes('secretary') || d.includes('property tax') ||
      d.includes('water for guys') || d.includes('sign for') || d.includes('business c') ||
      d.includes('checks') || d.includes('hats') || d.includes('phone case') ||
      d.includes('rocks building') || d.includes('po box') || d.includes('cash deposit') ||
      d.includes('cash fee') || d.includes('return check') || d.includes('closing cost') ||
      d.includes('building repair') || d.includes('maintance') || d.includes('equipment tax') ||
      d.includes('beebe') || d.includes('batteries') || d.includes('water pump') ||
      d.includes('steiner') || d.includes('ropes') || d.includes('contractors license'))
    return { category: 'Operations', is_recurring: false };

  // Other (tithes, mortgage, etc.)
  if (d.includes('tithe') || d.includes('mortgage') || d.includes('l&w') ||
      d.includes('shop') || d.includes('srfcu') || d.includes('sj loan') ||
      d.includes('al loan') || d.includes('patrick'))
    return { category: 'Other', is_recurring: false };

  return { category: 'Operations', is_recurring: false };
}

// ─── 2024 Income Data ───────────────────────────────────────────────────

const income2024: IncomeRow[] = [
  // January 2024
  { customer_name: 'Thomas Singley', amount: 2600, date: d(2024,1), job_type: 'tree_removal' },
  { customer_name: 'Digital Media', amount: 300, date: d(2024,1), job_type: 'tree_removal' },
  { customer_name: 'Matt Storr', amount: 600, date: d(2024,1), job_type: 'tree_removal' },
  { customer_name: 'Michelle Davis', amount: 800, date: d(2024,1), job_type: 'tree_removal' },
  { customer_name: 'Hunter Livery', amount: 300, date: d(2024,1), job_type: 'tree_removal' },
  { customer_name: 'Alston Reed', amount: 700, date: d(2024,1), job_type: 'tree_removal' },
  { customer_name: 'Kellie Davis', amount: 1600, date: d(2024,1), job_type: 'tree_removal' },
  { customer_name: 'Leigh/Edwin O Connor', amount: 150, date: d(2024,1), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 1400, date: d(2024,1), job_type: 'tree_removal' },

  // February 2024
  { customer_name: 'Vickey Lovorn', amount: 1500, date: d(2024,2), job_type: 'tree_removal' },
  { customer_name: 'Sonny Ehlers', amount: 800, date: d(2024,2), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 50, date: d(2024,2), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 400, date: d(2024,2), job_type: 'tree_removal' },
  { customer_name: 'Jan Salzer', amount: 2100, date: d(2024,2), job_type: 'tree_removal' },
  { customer_name: 'I.D. Stewart', amount: 1900, date: d(2024,2), job_type: 'tree_removal' },
  { customer_name: 'Susan Tolar Realty', amount: 1100, date: d(2024,2), job_type: 'tree_removal' },
  { customer_name: 'Ron/Pam Sheldon', amount: 800, date: d(2024,2), job_type: 'tree_removal' },
  { customer_name: 'Drew/Christmas lights', amount: 400, date: d(2024,2), job_type: 'tree_removal' },
  { customer_name: 'Larry/Pat Cooley', amount: 3000, date: d(2024,2), job_type: 'tree_removal' },
  { customer_name: 'Ilka Robertson', amount: 1700, date: d(2024,2), job_type: 'tree_removal' },
  { customer_name: 'Patricia Tallent', amount: 800, date: d(2024,2), job_type: 'tree_removal' },

  // March 2024
  { customer_name: 'R.V. Shields', amount: 650, date: d(2024,3), job_type: 'tree_removal' },
  { customer_name: 'James/Threresa Horne', amount: 300, date: d(2024,3), job_type: 'tree_removal' },
  { customer_name: 'City of Pascagoula', amount: 4000, date: d(2024,3), job_type: 'tree_removal' },
  { customer_name: 'Carvana (sold 2009 truck)', amount: 5610, date: d(2024,3), job_type: 'tree_removal' },
  { customer_name: 'Elliot Miller', amount: 4700, date: d(2024,3), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 1200, date: d(2024,3), job_type: 'tree_removal' },
  { customer_name: 'Mark/Susan Lee', amount: 2000, date: d(2024,3), job_type: 'tree_removal' },
  { customer_name: 'Tommy/Cecily Obrien', amount: 3000, date: d(2024,3), job_type: 'tree_removal' },
  { customer_name: 'David Lewis', amount: 2200, date: d(2024,3), job_type: 'tree_removal' },
  { customer_name: 'Sonny Ehlers', amount: 200, date: d(2024,3), job_type: 'tree_removal' },
  { customer_name: 'Indian Point', amount: 700, date: d(2024,3), job_type: 'tree_removal' },
  { customer_name: 'Chris Tillman', amount: 1800, date: d(2024,3), job_type: 'tree_removal' },
  { customer_name: 'David/Shirley', amount: 1400, date: d(2024,3), job_type: 'tree_removal' },
  { customer_name: 'Terry Scott', amount: 300, date: d(2024,3), job_type: 'tree_removal' },
  { customer_name: 'Dr Chris Wiggins', amount: 900, date: d(2024,3), job_type: 'tree_removal' },
  { customer_name: 'Ana Rodarte', amount: 1700, date: d(2024,3), job_type: 'tree_removal' },
  { customer_name: 'Anita/Donald Bosarge', amount: 3400, date: d(2024,3), job_type: 'tree_removal' },

  // April 2024
  { customer_name: 'Thomas Cochran', amount: 2500, date: d(2024,4), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 400, date: d(2024,4), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 400, date: d(2024,4), job_type: 'tree_removal' },
  { customer_name: 'WT/Shirley Beckman', amount: 3700, date: d(2024,4), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 2500, date: d(2024,4), job_type: 'tree_removal' },
  { customer_name: 'Emma Pellegrin', amount: 1900, date: d(2024,4), job_type: 'tree_removal' },
  { customer_name: 'Joseph/Deloris Larsen', amount: 4200, date: d(2024,4), job_type: 'tree_removal' },
  { customer_name: 'Regina Cobb', amount: 300, date: d(2024,4), job_type: 'tree_removal' },
  { customer_name: 'City of Pascagoula', amount: 2500, date: d(2024,4), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 2000, date: d(2024,4), job_type: 'tree_removal' },
  { customer_name: 'Myran/Coleen Dean', amount: 500, date: d(2024,4), job_type: 'tree_removal' },
  { customer_name: 'John Trehern', amount: 1200, date: d(2024,4), job_type: 'tree_removal' },

  // May 2024
  { customer_name: 'David Lewis', amount: 300, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Bonnie Cochran', amount: 450, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Sharon Baker', amount: 400, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Byron Allred', amount: 400, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Courtney Chappell', amount: 1000, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Mark/Renee Lee', amount: 1800, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Julie Watkins', amount: 800, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'City of Pascagoula', amount: 800, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 630, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Dyneshia/Michael Hale', amount: 3400, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Lena Ardell Hinton', amount: 2800, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 600, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Ann Summerlin', amount: 2000, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Gary Crawley', amount: 2000, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 450, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Ernest Temple', amount: 600, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Thomas Pearson', amount: 100, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Lynette Worthington', amount: 900, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Michael Lofton Sr', amount: 150, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 600, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Michael Barry', amount: 600, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Frances Chelette', amount: 300, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Emily Teeples', amount: 1100, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 1800, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 800, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Ann Summerlin', amount: 2200, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Patrick/Lisa Bryan', amount: 600, date: d(2024,5), job_type: 'tree_removal' },
  { customer_name: 'Pamela Wirth', amount: 600, date: d(2024,5), job_type: 'tree_removal' },

  // June 2024
  { customer_name: 'City of Pascagoula', amount: 700, date: d(2024,6), job_type: 'tree_removal' },
  { customer_name: 'Wanda/Benjamin Lambert', amount: 6400, date: d(2024,6), job_type: 'tree_removal' },
  { customer_name: 'Kim Seaman', amount: 1550, date: d(2024,6), job_type: 'tree_removal' },
  { customer_name: 'Gary/Dana Brown', amount: 300, date: d(2024,6), job_type: 'tree_removal' },
  { customer_name: 'Frank/Patti Sturges', amount: 950, date: d(2024,6), job_type: 'tree_removal' },
  { customer_name: 'Preston/Gerri Wells', amount: 500, date: d(2024,6), job_type: 'tree_removal' },
  { customer_name: 'Laurie Vice', amount: 400, date: d(2024,6), job_type: 'tree_removal' },
  { customer_name: 'Jeffrey Gandy', amount: 900, date: d(2024,6), job_type: 'tree_removal' },
  { customer_name: 'Wayne/Becky Barlow', amount: 3500, date: d(2024,6), job_type: 'tree_removal' },
  { customer_name: 'R.H./Peggy Ziegenfelder', amount: 3000, date: d(2024,6), job_type: 'tree_removal' },
  { customer_name: 'Barbara Tansil', amount: 1000, date: d(2024,6), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 1100, date: d(2024,6), job_type: 'tree_removal' },
  { customer_name: 'William/Angela Broome', amount: 950, date: d(2024,6), job_type: 'tree_removal' },
  { customer_name: 'Paul Sullivan Construction', amount: 900, date: d(2024,6), job_type: 'tree_removal' },
  { customer_name: 'Ruth Burchfield', amount: 900, date: d(2024,6), job_type: 'tree_removal' },
  { customer_name: 'Margret Moffett', amount: 600, date: d(2024,6), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 1000, date: d(2024,6), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 2500, date: d(2024,6), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 125, date: d(2024,6), job_type: 'tree_removal' },
  { customer_name: 'Melanie Landsiedel', amount: 1400, date: d(2024,6), job_type: 'tree_removal' },
  { customer_name: 'Frank Sturges', amount: 625, date: d(2024,6), job_type: 'tree_removal' },

  // July 2024
  { customer_name: 'Cash', amount: 1900, date: d(2024,7), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 2400, date: d(2024,7), job_type: 'tree_removal' },
  { customer_name: 'Larry/Linda Stringer', amount: 450, date: d(2024,7), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 150, date: d(2024,7), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 2200, date: d(2024,7), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 20, date: d(2024,7), job_type: 'tree_removal' },
  { customer_name: 'Martha Gambrell', amount: 5500, date: d(2024,7), job_type: 'tree_removal' },
  { customer_name: 'Jennifer Green', amount: 1600, date: d(2024,7), job_type: 'tree_removal' },
  { customer_name: 'Wayne/Becky Barlow', amount: 4800, date: d(2024,7), job_type: 'tree_removal' },
  { customer_name: 'Marine Flooring', amount: 2550, date: d(2024,7), job_type: 'tree_removal' },
  { customer_name: 'Michael/Debra Scott', amount: 500, date: d(2024,7), job_type: 'tree_removal' },
  { customer_name: 'Randall Mitchell', amount: 2400, date: d(2024,7), job_type: 'tree_removal' },
  { customer_name: 'Tiffany Gager', amount: 2500, date: d(2024,7), job_type: 'tree_removal' },
  { customer_name: 'Keith/Kristi Richards', amount: 300, date: d(2024,7), job_type: 'tree_removal' },
  { customer_name: 'Helen Steiner', amount: 5000, date: d(2024,7), job_type: 'tree_removal' },
  { customer_name: 'Michael/Angela Shotts', amount: 500, date: d(2024,7), job_type: 'tree_removal' },
  { customer_name: 'Alesia Combest', amount: 1750, date: d(2024,7), job_type: 'tree_removal' },

  // August 2024
  { customer_name: 'Shirley Patrick', amount: 400, date: d(2024,8), job_type: 'tree_removal' },
  { customer_name: 'Donna Krebs', amount: 1700, date: d(2024,8), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 800, date: d(2024,8), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 1200, date: d(2024,8), job_type: 'tree_removal' },
  { customer_name: 'Warren Getz', amount: 2800, date: d(2024,8), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 300, date: d(2024,8), job_type: 'tree_removal' },
  { customer_name: 'Linda Mizell', amount: 900, date: d(2024,8), job_type: 'tree_removal' },
  { customer_name: 'Carlos Fleming', amount: 1100, date: d(2024,8), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 3100, date: d(2024,8), job_type: 'tree_removal' },
  { customer_name: 'City of Pascagoula', amount: 2900, date: d(2024,8), job_type: 'tree_removal' },
  { customer_name: 'William Pope', amount: 2200, date: d(2024,8), job_type: 'tree_removal' },
  { customer_name: 'Warren Getz', amount: 1600, date: d(2024,8), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 300, date: d(2024,8), job_type: 'tree_removal' },
  { customer_name: 'S.D. Buckley', amount: 3000, date: d(2024,8), job_type: 'tree_removal' },
  { customer_name: 'Phyllis McCloskey', amount: 1100, date: d(2024,8), job_type: 'tree_removal' },
  { customer_name: 'Gail Millette', amount: 500, date: d(2024,8), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 600, date: d(2024,8), job_type: 'tree_removal' },
  { customer_name: 'David Nichols', amount: 4900, date: d(2024,8), job_type: 'tree_removal' },

  // September 2024
  { customer_name: 'Helen Steiner', amount: 1800, date: d(2024,9), job_type: 'tree_removal' },
  { customer_name: 'City of Pascagoula', amount: 800, date: d(2024,9), job_type: 'tree_removal' },
  { customer_name: 'Marsha Taylor', amount: 450, date: d(2024,9), job_type: 'tree_removal' },
  { customer_name: 'Bill Roberts', amount: 300, date: d(2024,9), job_type: 'tree_removal' },
  { customer_name: 'Eva', amount: 2900, date: d(2024,9), job_type: 'tree_removal' },
  { customer_name: 'Peter/Janet Muncie', amount: 1000, date: d(2024,9), job_type: 'tree_removal' },
  { customer_name: 'Coach', amount: 300, date: d(2024,9), job_type: 'tree_removal' },
  { customer_name: 'Joshua', amount: 250, date: d(2024,9), job_type: 'tree_removal' },
  { customer_name: 'Tim', amount: 1200, date: d(2024,9), job_type: 'tree_removal' },
  { customer_name: 'Martha', amount: 900, date: d(2024,9), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 1400, date: d(2024,9), job_type: 'tree_removal' },
  { customer_name: 'Rhonda (Indian Point)', amount: 1600, date: d(2024,9), job_type: 'tree_removal' },
  { customer_name: 'Christopher', amount: 2000, date: d(2024,9), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 1900, date: d(2024,9), job_type: 'tree_removal' },
  { customer_name: 'Cash (stump)', amount: 75, date: d(2024,9), job_type: 'stump_grinding' },
  { customer_name: 'Cash', amount: 1500, date: d(2024,9), job_type: 'tree_removal' },
  { customer_name: 'Sharon Armond', amount: 700, date: d(2024,9), job_type: 'tree_removal' },

  // October 2024
  { customer_name: 'Sayles/Mae Johnson', amount: 4800, date: d(2024,10), job_type: 'tree_removal' },
  { customer_name: 'Evie Hosking', amount: 500, date: d(2024,10), job_type: 'tree_removal' },
  { customer_name: 'David McIntosh', amount: 850, date: d(2024,10), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 575, date: d(2024,10), job_type: 'tree_removal' },
  { customer_name: 'Rodney Swilley', amount: 2500, date: d(2024,10), job_type: 'tree_removal' },
  { customer_name: 'New Generation Christian Fellowship', amount: 1100, date: d(2024,10), job_type: 'tree_removal' },
  { customer_name: 'Ernest/Jillian Bowers', amount: 300, date: d(2024,10), job_type: 'tree_removal' },
  { customer_name: 'Pete/Janet Muncie', amount: 700, date: d(2024,10), job_type: 'tree_removal' },
  { customer_name: 'Riverside Auto Sales', amount: 800, date: d(2024,10), job_type: 'tree_removal' },
  { customer_name: 'Sharon Lucas', amount: 2000, date: d(2024,10), job_type: 'tree_removal' },
  { customer_name: 'Gregory/Pamela Smith', amount: 1200, date: d(2024,10), job_type: 'tree_removal' },
  { customer_name: 'City of Moss Point', amount: 2200, date: d(2024,10), job_type: 'tree_removal' },
  { customer_name: 'Michael Hale', amount: 800, date: d(2024,10), job_type: 'tree_removal' },
  { customer_name: 'Kenneth Leggett', amount: 1050, date: d(2024,10), job_type: 'tree_removal' },
  { customer_name: 'Moss Point Presbyterian Church', amount: 1200, date: d(2024,10), job_type: 'tree_removal' },
  { customer_name: 'Cash (Jerry)', amount: 1000, date: d(2024,10), job_type: 'tree_removal' },
  { customer_name: 'Finished stump on job', amount: 300, date: d(2024,10), job_type: 'stump_grinding' },

  // November 2024
  { customer_name: 'Cash', amount: 1000, date: d(2024,11), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 6100, date: d(2024,11), job_type: 'tree_removal' },
  { customer_name: 'Paul Clark', amount: 600, date: d(2024,11), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 100, date: d(2024,11), job_type: 'tree_removal' },
  { customer_name: 'City of Pascagoula', amount: 800, date: d(2024,11), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 1000, date: d(2024,11), job_type: 'tree_removal' },
  { customer_name: 'Cindy Jensen', amount: 900, date: d(2024,11), job_type: 'tree_removal' },

  // December 2024
  { customer_name: 'Paul Sullivan', amount: 1200, date: d(2024,12), job_type: 'tree_removal' },
  { customer_name: 'Gary & Shavaun Crawley', amount: 2300, date: d(2024,12), job_type: 'tree_removal' },
  { customer_name: 'William/Sheila Muzzy', amount: 600, date: d(2024,12), job_type: 'tree_removal' },
  { customer_name: 'Howard/Ruth Frazier', amount: 2100, date: d(2024,12), job_type: 'tree_removal' },
  { customer_name: 'Mark Carter', amount: 1400, date: d(2024,12), job_type: 'tree_removal' },
  { customer_name: 'La Pointe Krebs Museum', amount: 1400, date: d(2024,12), job_type: 'tree_removal' },
  { customer_name: 'City of Pascagoula', amount: 3000, date: d(2024,12), job_type: 'tree_removal' },
  { customer_name: 'City of Pascagoula', amount: 1600, date: d(2024,12), job_type: 'tree_removal' },
];

// ─── 2025 Income Data ───────────────────────────────────────────────────

const income2025: IncomeRow[] = [
  // January 2025 - no income entries (all Name/0.0)

  // February 2025
  { customer_name: 'Courtney Chappell', amount: 900, date: d(2025,2), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 1300, date: d(2025,2), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 7000, date: d(2025,2), job_type: 'tree_removal' },
  { customer_name: 'Margie Szymonik', amount: 100, date: d(2025,2), job_type: 'tree_removal' },
  { customer_name: 'Josie Miletch', amount: 1700, date: d(2025,2), job_type: 'tree_removal' },
  { customer_name: 'Brian Clark', amount: 1050, date: d(2025,2), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 175, date: d(2025,2), job_type: 'tree_removal' },
  { customer_name: 'Sail Enterprise', amount: 900, date: d(2025,2), job_type: 'tree_removal' },
  { customer_name: 'Nathan/Laura Burrow', amount: 1700, date: d(2025,2), job_type: 'tree_removal' },
  { customer_name: 'Chris Blythe', amount: 800, date: d(2025,2), job_type: 'tree_removal' },
  { customer_name: 'David Nelson', amount: 200, date: d(2025,2), job_type: 'tree_removal' },

  // March 2025
  { customer_name: 'Gail Martin', amount: 2600, date: d(2025,3), job_type: 'tree_removal' },
  { customer_name: 'Southcoast Contracting', amount: 1600, date: d(2025,3), job_type: 'tree_removal' },
  { customer_name: 'Mary/Glen Richards', amount: 400, date: d(2025,3), job_type: 'tree_removal' },
  { customer_name: 'Compass Pointe Apartments', amount: 3850, date: d(2025,3), job_type: 'tree_removal' },
  { customer_name: 'City of Pascagoula', amount: 900, date: d(2025,3), job_type: 'tree_removal' },
  { customer_name: 'Linda Little', amount: 3500, date: d(2025,3), job_type: 'tree_removal' },
  { customer_name: 'Katherine Michelle Shanks', amount: 500, date: d(2025,3), job_type: 'tree_removal' },
  { customer_name: 'JSJ Investments', amount: 800, date: d(2025,3), job_type: 'tree_removal' },
  { customer_name: 'David (cash)', amount: 500, date: d(2025,3), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 2000, date: d(2025,3), job_type: 'tree_removal' },
  { customer_name: 'Russell Gill', amount: 1700, date: d(2025,3), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 800, date: d(2025,3), job_type: 'tree_removal' },
  { customer_name: 'Rolanda Herring', amount: 2000, date: d(2025,3), job_type: 'tree_removal' },
  { customer_name: 'Antonette Weber', amount: 500, date: d(2025,3), job_type: 'tree_removal' },
  { customer_name: 'Rebecca Sprecken', amount: 600, date: d(2025,3), job_type: 'tree_removal' },
  { customer_name: 'Sue Grubbs', amount: 3000, date: d(2025,3), job_type: 'tree_removal' },
  { customer_name: 'Joseph/Deloris Larsen', amount: 920, date: d(2025,3), job_type: 'tree_removal' },
  { customer_name: 'David Cunningham', amount: 900, date: d(2025,3), job_type: 'tree_removal' },
  { customer_name: 'Cash (stump)', amount: 140, date: d(2025,3), job_type: 'stump_grinding' },
  { customer_name: 'City of Pascagoula', amount: 1800, date: d(2025,3), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 2100, date: d(2025,3), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 600, date: d(2025,3), job_type: 'tree_removal' },

  // April 2025
  { customer_name: 'City of Pascagoula', amount: 1700, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'City of Pascagoula', amount: 2100, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Rhonda/Robert Faucette', amount: 2000, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Jonathan Roy', amount: 500, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Eddie Waters', amount: 2200, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Becky Etheridge', amount: 2300, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Edith Lofton', amount: 1700, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Edith Lofton', amount: 1100, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 2300, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 2550, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 1000, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Sheila Smith', amount: 1000, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Cash (Sheila Smith)', amount: 2200, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 1050, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Jason/Algaree Halley', amount: 8200, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'James/Delta Goss', amount: 300, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 500, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 700, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Dr Holbert', amount: 400, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Cash (Larry)', amount: 460, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Pet Harbor', amount: 1000, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Jocey Stork', amount: 900, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Gentry Williams', amount: 800, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 2000, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Cash (Olivia)', amount: 800, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 100, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Juanita Debose', amount: 2500, date: d(2025,4), job_type: 'tree_removal' },
  { customer_name: 'Pat Cooley', amount: 5200, date: d(2025,4), job_type: 'tree_removal' },

  // May 2025
  { customer_name: 'Leroy/Jeannie Faucett', amount: 1050, date: d(2025,5), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 500, date: d(2025,5), job_type: 'tree_removal' },
  { customer_name: 'Hilton Garden Inn', amount: 2100, date: d(2025,5), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 2400, date: d(2025,5), job_type: 'tree_removal' },
  { customer_name: 'Mr Price', amount: 1600, date: d(2025,5), job_type: 'tree_removal' },
  { customer_name: 'Jennifer Neher', amount: 500, date: d(2025,5), job_type: 'tree_removal' },
  { customer_name: 'Linda Moore', amount: 2100, date: d(2025,5), job_type: 'tree_removal' },
  { customer_name: 'James/Peggy Hinman', amount: 600, date: d(2025,5), job_type: 'tree_removal' },
  { customer_name: 'Ernest Bowers', amount: 300, date: d(2025,5), job_type: 'tree_removal' },
  { customer_name: 'Dennis Reeves', amount: 1300, date: d(2025,5), job_type: 'tree_removal' },
  { customer_name: 'Ellery/Frances Ferrara', amount: 700, date: d(2025,5), job_type: 'tree_removal' },
  { customer_name: 'Harry/Dorothy Mullen', amount: 3000, date: d(2025,5), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 600, date: d(2025,5), job_type: 'tree_removal' },
  { customer_name: 'Farron Gabhart', amount: 2300, date: d(2025,5), job_type: 'tree_removal' },
  { customer_name: 'Rebecca/Dennis Wood', amount: 1000, date: d(2025,5), job_type: 'tree_removal' },

  // June 2025
  { customer_name: 'Judy (cash)', amount: 3100, date: d(2025,6), job_type: 'tree_removal' },
  { customer_name: 'Krystal Head', amount: 500, date: d(2025,6), job_type: 'tree_removal' },
  { customer_name: 'Krystal Head', amount: 400, date: d(2025,6), job_type: 'tree_removal' },
  { customer_name: 'Josie Miletich', amount: 1300, date: d(2025,6), job_type: 'tree_removal' },
  { customer_name: 'Daniel Moseley', amount: 1400, date: d(2025,6), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 2100, date: d(2025,6), job_type: 'tree_removal' },
  { customer_name: 'St Paul United Methodist Church', amount: 450, date: d(2025,6), job_type: 'tree_removal' },
  { customer_name: 'Daniel Moseley', amount: 1400, date: d(2025,6), job_type: 'tree_removal' },
  { customer_name: 'William Jones', amount: 300, date: d(2025,6), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 600, date: d(2025,6), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 2000, date: d(2025,6), job_type: 'tree_removal' },
  { customer_name: 'Graham Construction', amount: 2500, date: d(2025,6), job_type: 'tree_removal' },
  { customer_name: 'Dorsey/Margie Burton', amount: 4400, date: d(2025,6), job_type: 'tree_removal' },
  { customer_name: 'Indian Point Campground', amount: 4100, date: d(2025,6), job_type: 'tree_removal' },
  { customer_name: 'Indian Point Campground', amount: 100, date: d(2025,6), job_type: 'tree_removal' },
  { customer_name: 'City of Pascagoula', amount: 1100, date: d(2025,6), job_type: 'tree_removal' },
  { customer_name: 'Bruce/Karen Dansby', amount: 2200, date: d(2025,6), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 800, date: d(2025,6), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 2000, date: d(2025,6), job_type: 'tree_removal' },
  { customer_name: 'Cathy', amount: 1400, date: d(2025,6), job_type: 'tree_removal' },

  // July 2025
  { customer_name: 'Pearson Investments', amount: 400, date: d(2025,7), job_type: 'tree_removal' },
  { customer_name: 'JSJ Investments', amount: 1050, date: d(2025,7), job_type: 'tree_removal' },
  { customer_name: 'Roughwater Marine & Auto', amount: 1400, date: d(2025,7), job_type: 'tree_removal' },
  { customer_name: 'James/Annie Collier', amount: 900, date: d(2025,7), job_type: 'tree_removal' },
  { customer_name: 'Donald Cofield', amount: 3200, date: d(2025,7), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 2000, date: d(2025,7), job_type: 'tree_removal' },
  { customer_name: 'David Lewis', amount: 2150, date: d(2025,7), job_type: 'tree_removal' },
  { customer_name: 'Connie Hobbs', amount: 2200, date: d(2025,7), job_type: 'tree_removal' },
  { customer_name: 'Bert/Ann Smith', amount: 2750, date: d(2025,7), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 100, date: d(2025,7), job_type: 'tree_removal' },
  { customer_name: 'Karla/William Dickens', amount: 1500, date: d(2025,7), job_type: 'tree_removal' },
  { customer_name: 'James Douglas', amount: 1900, date: d(2025,7), job_type: 'tree_removal' },
  { customer_name: 'Rosemary/David Butt', amount: 850, date: d(2025,7), job_type: 'tree_removal' },
  { customer_name: 'Michael Mangum', amount: 3200, date: d(2025,7), job_type: 'tree_removal' },
  { customer_name: 'City of Pascagoula', amount: 3800, date: d(2025,7), job_type: 'tree_removal' },
  { customer_name: 'Kelly/Jeffrey Roberts', amount: 3400, date: d(2025,7), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 800, date: d(2025,7), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 350, date: d(2025,7), job_type: 'tree_removal' },
  { customer_name: 'Sharon Young', amount: 2000, date: d(2025,7), job_type: 'tree_removal' },
  { customer_name: 'Law Firm', amount: 1900, date: d(2025,7), job_type: 'tree_removal' },
  { customer_name: 'Rex Foster', amount: 1900, date: d(2025,7), job_type: 'tree_removal' },
  { customer_name: 'Terry/Bobby Crump', amount: 3000, date: d(2025,7), job_type: 'tree_removal' },

  // August 2025
  { customer_name: 'Ellen Cole', amount: 1900, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 800, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 100, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'The Colonnades', amount: 443.95, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Carl & Judy Nulta', amount: 6400, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Mike & Christina West', amount: 450, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Cash (coach)', amount: 1500, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Cash (boston rd)', amount: 1100, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'City of Pascagoula', amount: 700, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Terry/Bobby Crump', amount: 1300, date: d(2025,8), job_type: 'stump_grinding' },
  { customer_name: 'Ellen Cole', amount: 200, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Tina Noto', amount: 500, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Brad Lott', amount: 1200, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Mark & Renee Lee', amount: 6600, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Thomas & Rachael Ashbaker', amount: 800, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 1200, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Dave & Dronda Gaunce', amount: 1100, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Agnes King', amount: 300, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 1400, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Michael & Sandra Overby', amount: 1900, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Byron Allred', amount: 1800, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Kelly Smith', amount: 300, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 1400, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Kelly Smith', amount: 1700, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Eugene Sipp Jr', amount: 225, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Joseph/Deloris Larsen', amount: 900, date: d(2025,8), job_type: 'tree_removal' },
  { customer_name: 'Sue Grubbs', amount: 2400, date: d(2025,8), job_type: 'tree_removal' },

  // September 2025
  { customer_name: 'Cash', amount: 1800, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 900, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 900, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'Mary Parker', amount: 400, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'Scott/Kristal Dickens', amount: 250, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 1100, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 200, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 50, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'City of Pascagoula', amount: 800, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'Compass Pointe Apartments', amount: 2675, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 100, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'Sandra Cooper', amount: 125, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'Matthew Kuluz', amount: 2800, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'Steve & Cindy Pierce', amount: 2200, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'Indian Point Campground', amount: 300, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 2000, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'Juanita Debose', amount: 2100, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'Rhonda Clark', amount: 900, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 600, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 400, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 1600, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'Suzanne/Frank Iodice', amount: 1825, date: d(2025,9), job_type: 'tree_removal' },
  { customer_name: 'Comfort Inn/Hwy 63', amount: 500, date: d(2025,9), job_type: 'tree_removal' },

  // October 2025
  { customer_name: 'Benjamin/Jacquelyn Chestang', amount: 8000, date: d(2025,10), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 1800, date: d(2025,10), job_type: 'tree_removal' },
  { customer_name: 'Community Care Network', amount: 1800, date: d(2025,10), job_type: 'tree_removal' },
  { customer_name: 'Thomas Singley MD', amount: 1800, date: d(2025,10), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 2800, date: d(2025,10), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 300, date: d(2025,10), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 150, date: d(2025,10), job_type: 'tree_removal' },
  { customer_name: 'Dudley/Diane Colvin', amount: 1200, date: d(2025,10), job_type: 'tree_removal' },
  { customer_name: 'WT/Shirley Beckham', amount: 1400, date: d(2025,10), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 500, date: d(2025,10), job_type: 'tree_removal' },
  { customer_name: 'Allen Prince', amount: 2000, date: d(2025,10), job_type: 'tree_removal' },
  { customer_name: 'City of Pascagoula', amount: 1700, date: d(2025,10), job_type: 'tree_removal' },
  { customer_name: 'Larry/Linda Stringer', amount: 500, date: d(2025,10), job_type: 'tree_removal' },
  { customer_name: 'Raymond Horn', amount: 900, date: d(2025,10), job_type: 'tree_removal' },
  { customer_name: 'Patricia Garrison', amount: 600, date: d(2025,10), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 500, date: d(2025,10), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 400, date: d(2025,10), job_type: 'tree_removal' },
  { customer_name: 'Lance McCarty', amount: 2600, date: d(2025,10), job_type: 'tree_removal' },
  { customer_name: 'Margret Moffett', amount: 400, date: d(2025,10), job_type: 'tree_removal' },
  { customer_name: 'City of Pascagoula', amount: 500, date: d(2025,10), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 1200, date: d(2025,10), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 2600, date: d(2025,10), job_type: 'tree_removal' },

  // November 2025
  { customer_name: 'Cash', amount: 1900, date: d(2025,11), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 2200, date: d(2025,11), job_type: 'tree_removal' },
  { customer_name: 'Kerri Locke', amount: 300, date: d(2025,11), job_type: 'tree_removal' },
  { customer_name: 'Spencer Bailey', amount: 1000, date: d(2025,11), job_type: 'tree_removal' },
  { customer_name: 'City of Pascagoula', amount: 950, date: d(2025,11), job_type: 'tree_removal' },

  // December 2025
  { customer_name: 'Donald/Ann Waller', amount: 1200, date: d(2025,12), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 1500, date: d(2025,12), job_type: 'tree_removal' },
  { customer_name: 'Stephen Smith', amount: 1100, date: d(2025,12), job_type: 'tree_removal' },
  { customer_name: 'Cash', amount: 300, date: d(2025,12), job_type: 'tree_removal' },
];

// ─── 2024 Expense Data ──────────────────────────────────────────────────

function buildExpenses(year: number, month: number, items: [string, number][]): ExpenseRow[] {
  return items
    .filter(([, amt]) => amt > 0)
    .map(([desc, amount]) => {
      const { category, is_recurring } = categorize(desc);
      return { description: desc, category, amount, date: d(year, month), is_recurring };
    });
}

const expenses2024: ExpenseRow[] = [
  // January 2024
  ...buildExpenses(2024, 1, [
    ['Foreman Labor (Dale)', 890],
    ['Groundcrew (Amy)', 130],
    ['Groundcrew (Daniel)', 620],
    ['Ground Crew (Lizzy)', 375],
    ['NFCU Toyota 2021', 655.21],
    ['Discover Card', 618],
    ['Cash deposit fee', 0.97],
    ['Skid Steer Payment', 2466.76],
    ['Ford 2020 Payment', 1076.15],
    ['State Farm', 463.28],
    ['Trailer 20ft payment', 340.10],
    ['Burlington (liability insurance)', 343.96],
    ['Building insurance', 334.88],
    ['CHEVY 2020 Payment', 971.32],
    ['American Express CC (CJENSEN)', 152.67],
    ['Regions CC', 120.86],
    ['M&M spider lift', 1803.78],
    ['Regions Line of Credit', 444.40],
    ['MS power', 89.86],
    ['Coastal alarm', 64.20],
    ['Stump grinder', 1993.50],
    ['Cell Phone', 243.84],
    ['Mortgage L&W Properties', 830.09],
    ['Wells Fargo credit card', 200],
    ['L.L. Bean Credit card', 539],
    ['AT&T internet', 97.31],
    ['City of MP water', 98.25],
  ]),

  // February 2024
  ...buildExpenses(2024, 2, [
    ['Foreman Labor (Dale)', 2350],
    ['Groundcrew (Amy)', 910],
    ['Groundcrew (Daniel)', 1240],
    ['Ground Crew (B Haas)', 120],
    ['Ground Crew (Darrell)', 840],
    ['IPFS building insurance', 334.88],
    ['SEB Mining dump', 342.40],
    ['Skid Steer Payment', 1233.38],
    ['Ford 2020 Payment', 1076.15],
    ['State Farm', 459.60],
    ['Trailer 20ft payment', 340.10],
    ['Burlington (liability insurance)', 343.96],
    ['Cash deposit fee', 5.60],
    ['CHEVY 2020 Payment', 971.32],
    ['American Express CC (CJENSEN)', 161.01],
    ['Regions CC', 150],
    ['AT&T internet', 97.31],
    ['M&M spider lift', 1803.78],
    ['Regions Line of Credit', 435.58],
    ['CPA', 250],
    ['MS power', 80.91],
    ['Coastal alarm', 64.20],
    ['Stump grinder', 1046.59],
    ['Cell Phone', 254.54],
    ['L&W properties', 830.09],
    ['Ropes', 345.05],
    ['Wells Fargo credit card', 198],
    ['L.L. Bean Credit card', 541],
    ['City of Moss Point water', 98.25],
    ['Discover card', 638],
  ]),

  // March 2024
  ...buildExpenses(2024, 3, [
    ['Foreman Labor (Dale)', 2740],
    ['Groundcrew (Amy)', 1235],
    ['Groundcrew (Daniel)', 1925],
    ['Ground Crew (Darrell)', 720],
    ['Reimbursement SJ 800/AL 1440', 2240],
    ['2009 Chevy Truck', 2066],
    ['2021 Toyota truck', 1310.42],
    ['Skid Steer Payment', 1233.38],
    ['Dump fees', 1095.68],
    ['Ford 2020 Payment', 1076.15],
    ['State Farm', 447.30],
    ['Trailer 20ft payment', 340.10],
    ['Stonemark (liability insurance)', 360.67],
    ['MS tax revenue', 25],
    ['CHEVY 2020 Payment', 971.32],
    ['American Express CC (CJENSEN)', 160.31],
    ['Regions CC', 122.48],
    ['City of MP water', 98.25],
    ['M&M spider lift', 1753.78],
    ['Regions Line of Credit', 426.94],
    ['CPA', 500],
    ['MS power', 83.98],
    ['Coastal alarm', 64.20],
    ['Stump grinder', 1046.59],
    ['Cell Phone', 243.84],
    ['L&W Properties', 830.09],
    ['Tithes ALCC', 250],
    ['Tithes VIMG', 250],
    ['AT&T internet', 97.31],
    ['Wells Fargo credit card', 189],
    ['L.L. Bean Credit card', 602],
    ['Tax Collector/Prop tax', 1696.66],
    ['Discover credit card', 639],
    ['IPFS corp', 334.88],
  ]),

  // April 2024
  ...buildExpenses(2024, 4, [
    ['Foreman Labor (Dale)', 4650],
    ['Groundcrew (Amy)', 1455],
    ['Groundcrew (Daniel)', 1520],
    ['Ground Crew (Darrell)', 1365],
    ['Dump fees', 958.72],
    ['Tires', 74.90],
    ['Regions credit card', 120],
    ['Skid Steer Payment', 1233.38],
    ['L&W properties', 830.09],
    ['Ford 2020 Payment', 1076.15],
    ['State Farm', 474.91],
    ['Trailer 20ft payment', 340.10],
    ['Burlington (liability insurance)', 343.96],
    ['AT&T internet building', 97.02],
    ['CHEVY 2020 Payment', 971.32],
    ['American Express CC (CJENSEN)', 122],
    ['Tax Collector', 286.12],
    ['Kubota parts', 294.70],
    ['M&M spider lift', 1803.78],
    ['Regions Line of Credit', 418.47],
    ['CPA', 350],
    ['MS power', 92.47],
    ['Coastal alarm', 64.20],
    ['Stump grinder', 1046.59],
    ['Cell Phone', 243.84],
    ['Discover card', 598],
    ['Tithes ALCC', 150],
    ['Tithes VIMG', 150],
    ['City of MP water', 98.25],
    ['Wells Fargo credit card', 194],
    ['L.L. Bean Credit card', 599],
    ['IPFS corp', 334.88],
    ['Secretary of State', 26.25],
  ]),

  // May 2024
  ...buildExpenses(2024, 5, [
    ['Foreman Labor (Dale)', 5290],
    ['Groundcrew (Amy)', 1725],
    ['Groundcrew (Daniel)', 2630],
    ['Ground Crew (Darrell Kraft)', 980],
    ['CITY MP Water', 98.95],
    ['Jim\'s Tires', 234.33],
    ['AT&T Shop internet', 97.02],
    ['Skid Steer Payment', 1233.38],
    ['Privilege License', 20],
    ['Ford 2020 Payment', 1076.15],
    ['State Farm', 532.04],
    ['Trailer 20ft payment', 340.10],
    ['Burlington (liability insurance)', 343.96],
    ['Building insurance IPFS', 334.88],
    ['CHEVY 2020 Payment', 971.32],
    ['American Express CC (CJENSEN)', 157.96],
    ['Regions CC', 1100],
    ['Hardy & Jacobson Insurance', 1071.36],
    ['M&M spider lift', 1803.78],
    ['CPA', 250],
    ['MS Power', 81.15],
    ['Coastal alarm', 64.20],
    ['Stump grinder', 1046.59],
    ['Cell Phone', 243.66],
    ['Tithes VIMG', 400],
    ['Discover card', 282.40],
    ['L.L. Bean Credit card', 648],
    ['NFCU 2021 Toyota truck', 1310.42],
  ]),

  // June 2024
  ...buildExpenses(2024, 6, [
    ['Foreman Labor (Dale)', 2840],
    ['Groundcrew (Amy)', 1450],
    ['Groundcrew (Daniel)', 2300],
    ['Ground Crew (Darrell)', 1350],
    ['Coastal Alarm', 64.20],
    ['MS Power', 88.51],
    ['Skid Steer Payment', 1233.38],
    ['Ford 2020 Payment', 1076.15],
    ['State Farm', 498.14],
    ['Trailer 20ft payment', 340.10],
    ['Burlington (liability insurance)', 343.96],
    ['AT&T internet', 97.02],
    ['CHEVY 2020 Payment', 971.32],
    ['American Express CC (CJENSEN)', 160.63],
    ['Regions CC', 3000],
    ['MP water bill', 98.95],
    ['M&M spider lift', 1803.78],
    ['Dump fees', 787.52],
    ['CPA', 250],
    ['Toyota 2021 truck note', 655.21],
    ['Tires', 196.88],
    ['Stump grinder', 1046.59],
    ['Cell Phone', 252.22],
    ['Hancock bank loan', 1351.53],
    ['Tithes VIMG', 400],
    ['Tag', 464.43],
    ['L.L. Bean Credit card', 731],
    ['IPFS building ins', 334.88],
    ['Water for guys', 61.84],
  ]),

  // July 2024
  ...buildExpenses(2024, 7, [
    ['Foreman Labor (Dale)', 5875],
    ['Groundcrew (Amy)', 2255],
    ['Groundcrew (Daniel)', 2645],
    ['Ground Crew (Darrell)', 1645],
    ['Skid Steer Payment', 1393.26],
    ['Ford 2020 Payment', 1024.90],
    ['State Farm', 498.14],
    ['Trailer 20ft payment', 340.10],
    ['Burlington (liability insurance)', 343.96],
    ['Jim Tires', 32.10],
    ['CHEVY 2020 Payment', 971.32],
    ['American Express CC (CJENSEN)', 160],
    ['Regions CC', 2800],
    ['MS Power', 99.55],
    ['M&M spider lift', 3656.27],
    ['DUMP fees SEB Mining', 205.44],
    ['Water bill', 98.95],
    ['AT&T internet', 97.28],
    ['Coastal alarm', 64.20],
    ['Stump grinder', 1046.59],
    ['Cell Phone', 252.22],
    ['IPFS building insurance', 334.88],
    ['Tithes ALCC', 300],
    ['Tithes VIMG', 300],
    ['Tax collector (tag)', 249.19],
    ['L.L. Bean Credit card', 672],
    ['Hancock Bank', 1351.53],
    ['Tax collector (equipment taxes)', 3168.48],
  ]),

  // August 2024
  ...buildExpenses(2024, 8, [
    ['Foreman Labor (Dale)', 4395],
    ['Groundcrew (Amy)', 2015],
    ['Groundcrew (Daniel)', 2090],
    ['Ground Crew (Darrell)', 1275],
    ['Jason Trailer', 1600],
    ['City of MP water', 98.95],
    ['Water pump stump grinder', 169.06],
    ['Jims Tires', 294.25],
    ['Ford 2020 Payment', 1024.90],
    ['State Farm', 508.80],
    ['Trailer 20ft payment', 340.10],
    ['AT&T internet at the shop', 97.28],
    ['2021 Toyota Tundra', 1310.42],
    ['CHEVY 2020 Payment', 966.32],
    ['American Express CC (CJENSEN)', 120],
    ['Regions CC', 1000],
    ['Dump fees', 1712],
    ['Hancock Bank Loan', 1351.53],
    ['IPFS building insurance', 334.88],
    ['CPA', 300],
    ['MS power', 90.34],
    ['Coastal alarm', 64.20],
    ['Stump grinder', 1046.59],
    ['Cell Phone', 252.36],
    ['Tithes ALCC', 150],
    ['Tithes VIMG', 150],
    ['TAG tax collector', 488.29],
    ['L.L. Bean Credit card', 664],
  ]),

  // September 2024
  ...buildExpenses(2024, 9, [
    ['Foreman Labor (Dale)', 2520],
    ['Groundcrew (Amy)', 1010],
    ['Groundcrew (Daniel)', 1185],
    ['Ground Crew (Bryer H)', 600],
    ['Ground Crew (Darrell)', 120],
    ['Water bill city of MP', 98.95],
    ['AT&T internet', 97.28],
    ['State Farm', 546.24],
    ['Trailer 20ft payment', 340.10],
    ['CHEVY 2020 Payment', 976.32],
    ['Regions CC', 600],
    ['Tax collector tags', 427.76],
    ['Spider lift remote', 2208.21],
    ['Hancock bank loan', 1351.53],
    ['CPA', 250],
    ['NFCU 2021 truck', 655.21],
    ['Stump grinder', 1046.59],
    ['Cell Phone', 252.36],
    ['Coastal alarm', 64.20],
    ['L.L. Bean Credit card', 0],
    ['Po Box fees + mailing spider remote', 244.20],
  ]),

  // October 2024
  ...buildExpenses(2024, 10, [
    ['Foreman Labor (Dale)', 4865],
    ['Groundcrew (Amy)', 1780],
    ['Groundcrew (Daniel)', 2490],
    ['Ground Crew (Bryer)', 1365],
    ['MS Power', 92.45],
    ['City of Gautier', 20],
    ['Ford 2020 Payment', 2152.30],
    ['State Farm', 549.35],
    ['Trailer 20ft payment', 340.10],
    ['Water Bill Moss Point', 98.95],
    ['CHEVY 2020 Payment', 971.32],
    ['American Express CC (CJENSEN)', 275],
    ['Regions CC', 1750],
    ['Batteries dale truck and black truck', 693.85],
    ['Liability ins pymt Hardy & Jacobson', 1193.48],
    ['Return check fee', 300],
    ['CPA', 400],
    ['Tires', 169.06],
    ['Coastal alarm', 64.20],
    ['Stump grinder', 1046.59],
    ['Cell Phone', 252.36],
    ['Hancock bank loan', 1351.53],
    ['Tithes ALCC', 200],
    ['Tithes VIMG', 200],
    ['2021 Toyota Truck', 655.21],
    ['Coastal ins building down pymt', 1099.46],
    ['L.L. Bean Credit card', 1387],
    ['Drive shaft stump grinder', 687.19],
    ['Dump fees', 616.32],
    ['AT&T internet', 97.51],
  ]),

  // November 2024
  ...buildExpenses(2024, 11, [
    ['Foreman Labor (Dale)', 1880],
    ['Groundcrew (Amy)', 620],
    ['Groundcrew (Daniel)', 875],
    ['AT&T internet', 97.51],
    ['City of Moss Point water', 98.95],
    ['Groundcrew (Bryer)', 150],
    ['Ford 2020 Payment', 1076.15],
    ['State Farm', 566.44],
    ['Trailer 20ft payment', 340.10],
    ['Hardy & Jacobson (liability insurance)', 425.91],
    ['CHEVY 2020 Payment', 971.32],
    ['American Express CC (CJENSEN)', 116.87],
    ['Regions CC', 1300],
    ['CPA', 238.89],
    ['MS power', 90.32],
    ['Coastal alarm', 64.20],
    ['Stump grinder', 1046.59],
    ['Cell Phone', 255.42],
    ['Tithes ALCC', 250],
    ['IPFS coastal building ins', 386.17],
    ['L.L. Bean Credit card', 696],
    ['Cash fee', 6.50],
  ]),

  // December 2024 - all expenses are 0
];

// ─── 2025 Expense Data ──────────────────────────────────────────────────

const expenses2025: ExpenseRow[] = [
  // January 2025
  ...buildExpenses(2025, 1, [
    ['Foreman Labor (Dale)', 800],
    ['Cash deposit fee', 12],
    ['Ford 2020 Payment', 1076.15],
    ['State Farm', 566.43],
    ['Trailer 20ft payment', 340.10],
    ['Burlington (liability insurance)', 391.63],
    ['Building insurance IPFS', 386.17],
    ['CHEVY 2020 Payment', 971.32],
    ['American Express CC (CJENSEN)', 156.74],
    ['Regions CC', 1000],
    ['Reimbursement receipts fix the bucket', 253.03],
    ['CPA', 340],
    ['MS power', 87.53],
    ['Coastal alarm', 64.20],
    ['Stump grinder', 1046.59],
    ['Cell Phone', 255.42],
    ['Hancock Bank Loan', 1351.53],
    ['Jims Tires', 42.80],
    ['L.L. Bean Credit card', 673],
    ['AT&T internet', 97.59],
    ['City of MP water', 133.31],
  ]),

  // February 2025
  ...buildExpenses(2025, 2, [
    ['Foreman Labor (Dale)', 2740],
    ['Groundcrew (Amy)', 1040],
    ['Groundcrew (Daniel)', 1085],
    ['Ground Crew (B Haas)', 720],
    ['IPFS building insurance', 387.17],
    ['State Farm', 562.33],
    ['Trailer 20ft payment', 340.10],
    ['Burlington (liability insurance)', 391.63],
    ['Cash deposit fee', 8.25],
    ['CHEVY 2020 Payment', 971.32],
    ['American Express CC (CJENSEN)', 157],
    ['Regions CC', 1000],
    ['AT&T internet', 97.59],
    ['NFCU truck 2021', 655.21],
    ['Regions Line of Credit', 150.90],
    ['CPA', 275],
    ['MS power', 75.79],
    ['Coastal alarm', 64.20],
    ['Stump grinder', 1046.59],
    ['Cell Phone', 255.46],
    ['Hancock Bank Loan', 1351.53],
    ['Tithes ALCC', 250],
    ['Tithes VIMG', 250],
    ['City of Pascagoula contractors license', 100],
    ['Jim Tires Black truck and repair', 1123.50],
    ['L.L. Bean Credit card', 675],
    ['City of Moss Point water', 133.31],
  ]),

  // March 2025
  ...buildExpenses(2025, 3, [
    ['Foreman Labor (Dale)', 4110],
    ['Groundcrew (Amy)', 1750],
    ['Groundcrew (Daniel)', 2135],
    ['Ground Crew (Bryer)', 600],
    ['Reimbursement SJ 554.22/AL 438.68', 992.90],
    ['Groundcrew (Jarred)', 700],
    ['2021 Toyota truck', 655.21],
    ['Steiners bar 66 and chain', 194.74],
    ['Sign for building SJ reimbursement', 1371.74],
    ['Ford 2020 Payment', 2101.05],
    ['State Farm', 557.80],
    ['Trailer 20ft payment', 340.10],
    ['Stonemark (liability insurance)', 391.63],
    ['MS tax revenue', 25],
    ['CHEVY 2020 Payment', 966.32],
    ['American Express CC (CJENSEN)', 108.68],
    ['Regions CC', 2200],
    ['City of MP water', 134.56],
    ['Veermer Stump grinder teeth', 1263.36],
    ['Regions Line of Credit', 3997.79],
    ['CPA', 300],
    ['MS power', 84.66],
    ['Coastal alarm', 64.20],
    ['Stump grinder', 1046.59],
    ['Cell Phone', 255.74],
    ['Hancock bank loan', 1351.53],
    ['Tithes VIMG', 900],
    ['AT&T internet', 97.59],
    ['L.L. Bean Credit card', 577],
    ['Cannon Ford oil change', 311.51],
    ['IPFS corp', 386.17],
  ]),

  // April 2025 - all expenses are 0

  // May 2025
  ...buildExpenses(2025, 5, [
    ['Foreman Labor (Dale)', 5550],
    ['Groundcrew (Amy)', 2435],
    ['Groundcrew (Daniel)', 2630],
    ['Ground Crew (Jarred)', 1540],
    ['CITY MP Water', 134.56],
    ['Jim\'s Tires', 500.76],
    ['AT&T Shop internet', 97.65],
    ['Delta world tires (chevy/Ford)', 2607.38],
    ['Ford 2020 Payment', 1076.15],
    ['State Farm', 543.77],
    ['Trailer 20ft payment', 340.10],
    ['Burlington (liability insurance)', 391.63],
    ['Building insurance IPFS', 386.17],
    ['CHEVY 2020 Payment', 971.32],
    ['Wells Fargo credit card', 300],
    ['Regions LOC', 4730.90],
    ['Hancock C C', 1540],
    ['Business cards/Checks', 104.40],
    ['CPA', 500],
    ['MS Power', 94.31],
    ['Coastal alarm', 64.20],
    ['Stump grinder', 996.75],
    ['Cell Phone', 255.74],
    ['Hancock loan', 1351.53],
    ['Hats (TJs Apparel)', 132.68],
    ['Payroll (Troy)', 800],
    ['Phone case/new phone (Dale)', 364.71],
    ['Property taxes', 1707.81],
    ['Regions account fee', 12],
  ]),

  // June 2025
  ...buildExpenses(2025, 6, [
    ['Foreman Labor (Dale)', 5555],
    ['Groundcrew (Amy)', 2755],
    ['Groundcrew (Daniel)', 2755],
    ['Ground Crew (Jarred)', 420],
    ['Ground Crew (Tori)', 105],
    ['Coastal Alarm', 64.20],
    ['MS Power', 99.45],
    ['Hancock C C', 3200],
    ['Hancock loan', 1351.53],
    ['Ford 2020 Payment', 1024.90],
    ['State Farm', 543.79],
    ['Trailer 20ft payment', 340.10],
    ['Burlington (liability insurance)', 391.63],
    ['AT&T internet', 97.65],
    ['CHEVY 2020 Payment', 971.32],
    ['Regions C C', 25],
    ['Regions CC (2600)', 650],
    ['MP water bill', 263.99],
    ['C&B Handling (spider lift repairs)', 16080.76],
    ['Dump fees', 428],
    ['CPA', 300],
    ['Toyota 2021 truck note', 655.21],
    ['Stump grinder', 1096.43],
    ['Cell Phone', 284.65],
    ['Building insurance IPFS', 386.17],
    ['Regions bank fee', 12],
    ['Cash Fee hancock bank', 1],
    ['Tag', 426.51],
    ['Wells Fargo C C', 500],
    ['Equipment taxes', 2442.64],
  ]),

  // July 2025
  ...buildExpenses(2025, 7, [
    ['Foreman Labor (Dale)', 5535],
    ['Groundcrew (Amy)', 3060],
    ['Groundcrew (Daniel)', 2635],
    ['Beebe\'s pest', 1120],
    ['NFCU 2021 toyota', 655.21],
    ['Ford 2020 Payment', 1076.15],
    ['State Farm', 543.79],
    ['Trailer 20ft payment', 340.10],
    ['Burlington (liability insurance)', 391.63],
    ['CHEVY 2020 Payment', 971.32],
    ['CPA fees', 1000],
    ['Regions CC', 244.48],
    ['MS Power', 144.86],
    ['Wells Fargo c.c.', 500],
    ['AT&T internet', 108.60],
    ['Coastal alarm', 64.20],
    ['Stump grinder', 1046.59],
    ['Cell Phone', 259.91],
    ['IPFS building insurance', 386.17],
    ['Hancock LOC', 300],
    ['Hancock c.c', 3000],
    ['Tax collector (tag)', 204.11],
    ['Regions 2600 card', 650],
    ['Hancock Bank loan', 1351.53],
  ]),

  // August 2025
  ...buildExpenses(2025, 8, [
    ['Foreman Labor (Dale)', 7540],
    ['Groundcrew (Amy)', 3000],
    ['Groundcrew (Daniel)', 3875],
    ['Rope Forestry supply', 165.41],
    ['City of MP water', 129.43],
    ['Ford 2020 Payment', 1024.90],
    ['State Farm', 539.66],
    ['Trailer 20ft payment', 340.10],
    ['AT&T internet at the shop', 108.25],
    ['2021 Toyota Tundra', 655.21],
    ['CHEVY 2020 Payment', 966.32],
    ['Hancock LOC', 600],
    ['Regions CC', 274.58],
    ['Dump fees', 410.88],
    ['Hancock Bank Loan', 1351.53],
    ['IPFS building insurance', 386.17],
    ['MS power', 157.18],
    ['Coastal alarm', 64.20],
    ['Stump grinder', 1046.59],
    ['Cell Phone', 259.58],
    ['PO BOX fee', 106],
    ['SJ loan payback', 450],
    ['AL loan payback', 500],
    ['TAG tax collector', 820.18],
    ['Wells Fargo credit card', 500],
    ['Hancock C.C.', 5500],
    ['Regions 2600', 650],
  ]),

  // September 2025
  ...buildExpenses(2025, 9, [
    ['Foreman Labor (Dale)', 4560],
    ['Groundcrew (Amy)', 1630],
    ['Groundcrew (Daniel)', 2265],
    ['Water bill city of MP', 129.43],
    ['AT&T internet', 108.25],
    ['MS Power', 153.91],
    ['Ford 2020 Payment', 1024.90],
    ['State Farm', 515.46],
    ['Trailer 20ft payment', 697.62],
    ['Dump fees', 102.72],
    ['CHEVY 2020 Payment', 966.32],
    ['Mullinax Ford part for ford', 85.76],
    ['Regions CC', 1355.73],
    ['Hancock bank loan', 1351.53],
    ['CPA', 801.67],
    ['NFCU 2021 truck', 655.21],
    ['Privilege license city of gautier', 20],
    ['Stump grinder', 1046.59],
    ['Cell Phone', 259.58],
    ['Hancock LOC', 600],
    ['Regions CC 2600', 650],
    ['IPFS Building ins', 386.17],
    ['Coastal alarm', 64.20],
    ['Wells Fargo C.C.', 500],
    ['Hancock C.C.', 2500],
  ]),

  // October 2025
  ...buildExpenses(2025, 10, [
    ['Foreman Labor (Dale)', 6305],
    ['Groundcrew (Amy)', 2455],
    ['Groundcrew (Daniel)', 3225],
    ['Ground Crew (John)', 300],
    ['MS Power', 139.32],
    ['Ford 2020 Payment', 1024.90],
    ['State Farm', 497.34],
    ['Water Bill Moss Point', 129.43],
    ['CHEVY 2020 Payment', 966.32],
    ['Regions CC 1963', 1376.94],
    ['Regions CC 2600', 650],
    ['Cannon Ford 2020 Transmission', 6145.37],
    ['Coastal alarm', 64.20],
    ['Cell Phone', 259.58],
    ['Hancock bank loan', 1351.53],
    ['Hancock LOC', 600],
    ['Hancock CC', 3000],
    ['2021 Toyota Truck', 655.21],
    ['Coastal ins building down pymt', 852.97],
    ['Wells Fargo', 500],
    ['AT&T internet', 108.58],
  ]),

  // November 2025
  ...buildExpenses(2025, 11, [
    ['Foreman Labor (Dale)', 1020],
    ['Groundcrew (Amy)', 540],
    ['Groundcrew (Daniel)', 615],
    ['AT&T internet', 108.58],
    ['City of Moss Point water', 129.43],
    ['Groundcrew (John Walker)', 215],
    ['Ford 2020 Payment', 1076.15],
    ['State Farm', 495.94],
    ['CHEVY 2020 Payment', 971.32],
    ['Regions CC 2600', 250],
    ['Hancock Line of Credit', 200],
    ['Wells Fargo CC', 200],
    ['Regions CC 1963', 150],
    ['MS power', 139.13],
    ['Coastal alarm', 64.20],
    ['Cell Phone', 259.58],
    ['Hancock Bank loan', 1351.53],
    ['Hancock CC both cards', 500],
    ['IPFS coastal building ins', 407.11],
    ['NFCU truck loan', 655.21],
    ['Cash fee', 3.50],
  ]),

  // December 2025 - all expenses are 0
];

// ─── Debt Tracker (from 2024 Summary year-end balances) ─────────────────

const debtData: DebtRow[] = [
  { name: 'Tractor (Kubota SVL75-2W)', original_amount: 67800, current_balance: 21038.31, monthly_payment: 1283.30 },
  { name: 'Trailer (Sheffield)', original_amount: 7913.61, current_balance: 6357.98, monthly_payment: 200 },
  { name: 'F250 Ford Truck', original_amount: 8660, current_balance: -3075.15, monthly_payment: 274 },
  { name: 'Dodge Truck (Chevy 2020)', original_amount: 5000, current_balance: -1126.21, monthly_payment: 300 },
  { name: 'HD60 SpiderLift (M&M Bank)', original_amount: 84506.65, current_balance: 10278.59, monthly_payment: 1754 },
  { name: 'Truck (M&M Bank)', original_amount: 8505.23, current_balance: 10295.24, monthly_payment: 440 },
  { name: 'Patrick Truck', original_amount: 8792, current_balance: -8757.17, monthly_payment: 500 },
  { name: 'Regions Line of Credit', original_amount: 14797.63, current_balance: 10295.24, monthly_payment: 440 },
  { name: 'Mastercard (Cindy Card)', original_amount: 20954.93, current_balance: 20954.93, monthly_payment: 500 },
  { name: 'Shelia', original_amount: 30850.73, current_balance: 30850.73, monthly_payment: 0 },
  { name: 'Amber', original_amount: 19330, current_balance: 19330, monthly_payment: 500 },
  { name: 'Amex (Cindy Card)', original_amount: 2694.45, current_balance: 2694.45, monthly_payment: 150 },
];

// ─── Crew Members ───────────────────────────────────────────────────────
// Daily rates estimated from typical monthly pay / typical work days
// Dale: ~$4000/mo avg, ~20 work days = $200/day
// Amy: ~$1500/mo avg, ~20 work days = $75/day
// Daniel: ~$2000/mo avg, ~20 work days = $100/day
// Darrell: ~$1000/mo avg, ~20 work days = $50/day
// Bryer: ~$600/mo avg, ~15 work days = $40/day
// Jarred: ~$700/mo, ~15 work days = $47/day
// Lizzy: appeared only in Jan 2024

const crewMembers: CrewMemberRow[] = [
  { name: 'Dale', daily_rate: 200, is_active: true },
  { name: 'Amy', daily_rate: 75, is_active: true },
  { name: 'Daniel', daily_rate: 100, is_active: true },
  { name: 'Darrell', daily_rate: 50, is_active: true },
  { name: 'Bryer', daily_rate: 40, is_active: true },
  { name: 'Jarred', daily_rate: 47, is_active: true },
  { name: 'Lizzy', daily_rate: 50, is_active: false },
  { name: 'Tori', daily_rate: 35, is_active: false },
  { name: 'Troy', daily_rate: 50, is_active: false },
  { name: 'John Walker', daily_rate: 50, is_active: true },
  { name: 'Dennis', daily_rate: 50, is_active: false },
  { name: 'B Haas', daily_rate: 40, is_active: false },
  { name: 'Dale Tait', daily_rate: 50, is_active: false },
  { name: 'Andrew Musa', daily_rate: 50, is_active: false },
];

// ─── Seed Functions ─────────────────────────────────────────────────────

async function clearTables() {
  console.log('Clearing existing seed data...');
  const tables = ['income_entries', 'expense_entries', 'debt_tracker', 'crew_members'];
  for (const table of tables) {
    const { error } = await supabase.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) console.warn(`  Warning clearing ${table}: ${error.message}`);
    else console.log(`  Cleared ${table}`);
  }
}

async function seedIncome() {
  const allIncome = [...income2024, ...income2025];
  console.log(`\nSeeding ${allIncome.length} income entries...`);

  // Insert in batches of 100
  for (let i = 0; i < allIncome.length; i += 100) {
    const batch = allIncome.slice(i, i + 100);
    const { error } = await supabase.from('income_entries').insert(batch);
    if (error) {
      console.error(`  Error inserting income batch ${i}: ${error.message}`);
    } else {
      console.log(`  Inserted income entries ${i + 1} - ${Math.min(i + 100, allIncome.length)}`);
    }
  }
}

async function seedExpenses() {
  const allExpenses = [...expenses2024, ...expenses2025];
  console.log(`\nSeeding ${allExpenses.length} expense entries...`);

  for (let i = 0; i < allExpenses.length; i += 100) {
    const batch = allExpenses.slice(i, i + 100);
    const { error } = await supabase.from('expense_entries').insert(batch);
    if (error) {
      console.error(`  Error inserting expense batch ${i}: ${error.message}`);
    } else {
      console.log(`  Inserted expense entries ${i + 1} - ${Math.min(i + 100, allExpenses.length)}`);
    }
  }
}

async function seedDebt() {
  console.log(`\nSeeding ${debtData.length} debt tracker entries...`);
  const { error } = await supabase.from('debt_tracker').insert(debtData);
  if (error) console.error(`  Error inserting debt: ${error.message}`);
  else console.log('  Debt tracker seeded successfully');
}

async function seedCrew() {
  console.log(`\nSeeding ${crewMembers.length} crew members...`);
  const { error } = await supabase.from('crew_members').insert(crewMembers);
  if (error) console.error(`  Error inserting crew: ${error.message}`);
  else console.log('  Crew members seeded successfully');
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log('=== A Kut Above Tree Service - Seed Data Script ===\n');
  console.log(`Supabase URL: ${process.env.SUPABASE_URL || '(using default)'}`);
  console.log(`Service key: ${process.env.SUPABASE_SERVICE_KEY ? '****' + process.env.SUPABASE_SERVICE_KEY.slice(-8) : 'NOT SET'}\n`);

  if (!process.env.SUPABASE_SERVICE_KEY) {
    console.error('ERROR: SUPABASE_SERVICE_KEY not found in environment. Set it in .env or export it.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const skipClear = args.includes('--no-clear');

  if (!skipClear) {
    await clearTables();
  }

  await seedIncome();
  await seedExpenses();
  await seedDebt();
  await seedCrew();

  console.log('\n=== Seed complete ===');

  // Summary
  const allIncome = [...income2024, ...income2025];
  const allExpenses = [...expenses2024, ...expenses2025];
  const totalIncome = allIncome.reduce((s, e) => s + e.amount, 0);
  const totalExpenses = allExpenses.reduce((s, e) => s + e.amount, 0);

  console.log(`\nSummary:`);
  console.log(`  Income entries: ${allIncome.length} (total: $${totalIncome.toLocaleString()})`);
  console.log(`  Expense entries: ${allExpenses.length} (total: $${totalExpenses.toLocaleString()})`);
  console.log(`  Debt records: ${debtData.length}`);
  console.log(`  Crew members: ${crewMembers.length}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
