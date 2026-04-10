import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = typeof __dirname !== 'undefined'
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(scriptDir, '..', '.env') });

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://fogmqtnvmwahkmngmkds.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'SERVICE_KEY_HERE'
);

// Crew work schedule patterns (roughly how many days per month each person works)
// Based on a tree service: busy spring/summer/fall, slower winter
const SEASONAL_MULTIPLIER: Record<number, number> = {
  1: 0.5,   // January - slow
  2: 0.5,   // February - slow
  3: 0.7,   // March - picking up
  4: 0.85,  // April - busy season starting
  5: 1.0,   // May - peak
  6: 1.0,   // June - peak
  7: 0.9,   // July - hot, still busy
  8: 0.95,  // August - busy
  9: 0.9,   // September - fall season
  10: 0.85, // October - winding down
  11: 0.6,  // November - slowing
  12: 0.4,  // December - slowest
};

function getWorkingDays(year: number, month: number): number[] {
  const days: number[] = [];
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const dayOfWeek = new Date(year, month - 1, d).getDay();
    // Skip Sundays (0), keep Saturday as occasional work day
    if (dayOfWeek !== 0) {
      days.push(d);
    }
  }
  return days;
}

// Crew activity patterns - how often they work (1 = every workday, 0.5 = half the time)
interface CrewPattern {
  name: string;
  frequency2025: number; // work frequency in 2025
  frequency2026: number; // work frequency in 2026 (some get raises, some leave)
  activeMonths2025: number[]; // months active in 2025
  activeMonths2026: number[]; // months active in 2026
}

const crewPatterns: CrewPattern[] = [
  {
    name: 'Dale',
    frequency2025: 0.9, frequency2026: 0.85,
    activeMonths2025: [1,2,3,4,5,6,7,8,9,10,11,12],
    activeMonths2026: [1,2,3,4],
  },
  {
    name: 'Amy',
    frequency2025: 0.7, frequency2026: 0.7,
    activeMonths2025: [1,2,3,4,5,6,7,8,9,10,11,12],
    activeMonths2026: [1,2,3,4],
  },
  {
    name: 'Daniel',
    frequency2025: 0.85, frequency2026: 0.85,
    activeMonths2025: [1,2,3,4,5,6,7,8,9,10,11,12],
    activeMonths2026: [1,2,3,4],
  },
  {
    name: 'Darrell',
    frequency2025: 0.6, frequency2026: 0.65,
    activeMonths2025: [3,4,5,6,7,8,9,10,11],
    activeMonths2026: [1,2,3,4],
  },
  {
    name: 'Bryer',
    frequency2025: 0.55, frequency2026: 0.6,
    activeMonths2025: [4,5,6,7,8,9,10],
    activeMonths2026: [1,2,3,4],
  },
  {
    name: 'Jarred',
    frequency2025: 0.5, frequency2026: 0.55,
    activeMonths2025: [3,4,5,6,7,8,9,10],
    activeMonths2026: [1,2,3,4],
  },
  {
    name: 'John Walker',
    frequency2025: 0.65, frequency2026: 0.7,
    activeMonths2025: [1,2,3,4,5,6,7,8,9,10,11,12],
    activeMonths2026: [1,2,3,4],
  },
];

// Use a seeded random for reproducibility
let seed = 42;
function seededRandom(): number {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

async function main() {
  console.log('=== Seed Crew Daily Logs for 2025 & 2026 ===\n');

  if (!process.env.SUPABASE_SERVICE_KEY) {
    console.error('ERROR: SUPABASE_SERVICE_KEY not found. Set it in .env');
    process.exit(1);
  }

  // Get existing crew members
  const { data: members, error: membersError } = await supabase
    .from('crew_members')
    .select('id, name');

  if (membersError) {
    console.error('Error fetching crew members:', membersError.message);
    process.exit(1);
  }

  if (!members || members.length === 0) {
    console.error('No crew members found. Run the main seed script first.');
    process.exit(1);
  }

  console.log(`Found ${members.length} crew members:`);
  members.forEach((m) => console.log(`  - ${m.name} (${m.id})`));

  // Build name -> id map
  const nameToId: Record<string, string> = {};
  for (const m of members) {
    nameToId[m.name] = m.id;
  }

  // Clear existing crew logs
  console.log('\nClearing existing crew_daily_log...');
  const { error: clearError } = await supabase
    .from('crew_daily_log')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000');
  if (clearError) console.warn('  Warning clearing logs:', clearError.message);
  else console.log('  Cleared crew_daily_log');

  // Generate logs
  const allLogs: { crew_member_id: string; date: string; worked: boolean }[] = [];

  for (const pattern of crewPatterns) {
    const memberId = nameToId[pattern.name];
    if (!memberId) {
      console.warn(`  Skipping ${pattern.name} - not found in crew_members table`);
      continue;
    }

    // 2025 logs
    for (const month of pattern.activeMonths2025) {
      const workingDays = getWorkingDays(2025, month);
      const seasonalFactor = SEASONAL_MULTIPLIER[month] || 0.7;
      const effectiveFreq = pattern.frequency2025 * seasonalFactor;

      for (const day of workingDays) {
        if (seededRandom() < effectiveFreq) {
          const dateStr = `2025-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          allLogs.push({ crew_member_id: memberId, date: dateStr, worked: true });
        }
      }
    }

    // 2026 logs (only up to April since current date is April 7, 2026)
    for (const month of pattern.activeMonths2026) {
      const workingDays = getWorkingDays(2026, month);
      const seasonalFactor = SEASONAL_MULTIPLIER[month] || 0.7;
      const effectiveFreq = pattern.frequency2026 * seasonalFactor;

      // For April 2026, only include days up to the 7th
      const maxDay = month === 4 ? 7 : 31;

      for (const day of workingDays) {
        if (day > maxDay) continue;
        if (seededRandom() < effectiveFreq) {
          const dateStr = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          allLogs.push({ crew_member_id: memberId, date: dateStr, worked: true });
        }
      }
    }
  }

  console.log(`\nGenerated ${allLogs.length} crew log entries`);

  // Insert in batches of 500
  const batchSize = 500;
  for (let i = 0; i < allLogs.length; i += batchSize) {
    const batch = allLogs.slice(i, i + batchSize);
    const { error } = await supabase.from('crew_daily_log').insert(batch);
    if (error) {
      console.error(`  Error inserting batch ${i / batchSize + 1}:`, error.message);
    } else {
      console.log(`  Inserted batch ${i / batchSize + 1} (${batch.length} records)`);
    }
  }

  // Summary
  const logs2025 = allLogs.filter((l) => l.date.startsWith('2025'));
  const logs2026 = allLogs.filter((l) => l.date.startsWith('2026'));
  console.log(`\n=== Summary ===`);
  console.log(`  2025 logs: ${logs2025.length}`);
  console.log(`  2026 logs: ${logs2026.length}`);
  console.log(`  Total: ${allLogs.length}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
