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

// Monthly pay data extracted from all spreadsheets
// Format: { year, month, crewName (normalized), totalPay }
// crewName must match what's in crew_members table

interface MonthlyPay {
  year: number;
  month: number;
  name: string; // normalized crew member name
  amount: number;
}

// Normalize raw spreadsheet crew names to DB crew member names
function normalizeName(raw: string): string | null {
  const r = raw.toLowerCase();
  if (r.includes('dale') && !r.includes('tait')) return 'Dale';
  if (r.includes('amy') || r.includes('lusby')) return 'Amy';
  if (r.includes('daniel')) return 'Daniel';
  if (r.includes('darrell') || r.includes('kraft')) return 'Darrell';
  if (r.includes('bryer') || r.includes('byar')) return 'Bryer';
  if (r.includes('jarred') || r.includes('jared')) return 'Jarred';
  if (r.includes('lizzy') || r.includes('elizabeth')) return 'Lizzy';
  if (r.includes('tori')) return 'Tori';
  if (r.includes('troy')) return 'Troy';
  if (r.includes('john walker') || (r.includes('john') && !r.includes('willie') && !r.includes('colgin') && !r.includes('kelly') && !r.includes('watson') && !r.includes('ecker'))) return 'John Walker';
  if (r.includes('dennis')) return 'Dennis';
  if (r.includes('b haas')) return 'B Haas';
  if (r.includes('dale tait')) return 'Dale Tait';
  if (r.includes('andrew musa')) return 'Andrew Musa';
  // Skip non-crew entries
  return null;
}

// All crew labor data from spreadsheets (extracted via Python)
const rawCrewPay: { year: number; month: number; rawName: string; amount: number }[] = [
  // 2019
  {year:2019,month:1,rawName:'Forman Labor (Dale )',amount:4150},{year:2019,month:1,rawName:'Ground Crew (Robert )',amount:160},{year:2019,month:1,rawName:'Ground Crew (Shaun Knight)',amount:150},
  {year:2019,month:2,rawName:'Forman Labor (Dale )',amount:3500},{year:2019,month:2,rawName:'Climber (Aaron )',amount:1387.5},{year:2019,month:2,rawName:'Climber (Derek )',amount:550},{year:2019,month:2,rawName:'Ground Crew (Robert )',amount:435},{year:2019,month:2,rawName:'Ground Crew (Mitch)',amount:500},
  {year:2019,month:3,rawName:'Forman Labor (Dale )',amount:3900},{year:2019,month:3,rawName:'Climber (Aaron)',amount:1350},{year:2019,month:3,rawName:'Climber (Derek )',amount:1910},{year:2019,month:3,rawName:'Ground Crew  (Brent)',amount:1190},{year:2019,month:3,rawName:'Ground Crew (Lizzy)',amount:200},
  {year:2019,month:4,rawName:'Foreman Labor (Dale )',amount:3600},{year:2019,month:4,rawName:'Ground Crew (Derek)',amount:660},{year:2019,month:4,rawName:'Climber (Troy)',amount:1564.83},{year:2019,month:4,rawName:'Ground Crew (Brent )',amount:700},{year:2019,month:4,rawName:'Ground Crew (Mitch )',amount:950},{year:2019,month:4,rawName:'Ground Crew (Raymond)',amount:737.5},{year:2019,month:4,rawName:'Ground crew(byron)',amount:375},
  {year:2019,month:5,rawName:'Forman Labor (Dale )',amount:5200},{year:2019,month:5,rawName:'ground crew (Amy)',amount:100},{year:2019,month:5,rawName:'Climber (Troy)',amount:2993.63},{year:2019,month:5,rawName:'ground crew (Raymond)',amount:750},{year:2019,month:5,rawName:'Ground Crew (Marla)',amount:1760},{year:2019,month:5,rawName:'ground crew  (Mitch)',amount:750},{year:2019,month:5,rawName:'Ground crew(Elizabeth)',amount:300},{year:2019,month:5,rawName:'Ground crew(John C.)',amount:2400},
  {year:2019,month:6,rawName:'Forman Labor (Dale )',amount:3775},{year:2019,month:6,rawName:'Groundcrew (Amy)',amount:1775},{year:2019,month:6,rawName:'Climber (Troy)',amount:461.75},{year:2019,month:6,rawName:'Groundcrew (John C )',amount:1250},{year:2019,month:6,rawName:'Ground Crew (John K )',amount:1375},{year:2019,month:6,rawName:'Ground Crew (Robert F)',amount:250},{year:2019,month:6,rawName:'Groundcrew(Marla)',amount:400},{year:2019,month:6,rawName:'Groundcrew(E.Hartfield)',amount:150},{year:2019,month:6,rawName:'Ground crew(Marsha)',amount:1250},
  {year:2019,month:7,rawName:'Forman Labor (Dale )',amount:3425},{year:2019,month:7,rawName:'Groundcrew (Amy)',amount:980},{year:2019,month:7,rawName:'Groundcrew (J.Colgin)',amount:250},{year:2019,month:7,rawName:'Ground Crew (marsha)',amount:805},{year:2019,month:7,rawName:'Ground Crew (J.Kelly)',amount:750},{year:2019,month:7,rawName:'Ground Crew (E.Moore)',amount:100},
  {year:2019,month:8,rawName:'Forman Labor (Dale )',amount:4900},{year:2019,month:8,rawName:'Groundmen (Amy)',amount:2130},{year:2019,month:8,rawName:'want a be climber (John)',amount:2040},{year:2019,month:8,rawName:'Ground Crew (Marsha)',amount:300},{year:2019,month:8,rawName:'Ground Crew (Daniel)',amount:1400},{year:2019,month:8,rawName:'Ground Crew (Ledric)',amount:1400},
  {year:2019,month:9,rawName:'Foreman Labor (Dale )',amount:4640},{year:2019,month:9,rawName:'ground supervisor (Amy)',amount:2145},{year:2019,month:9,rawName:'Skid steer operator(Daniel)',amount:1470},{year:2019,month:9,rawName:'Ground Crew (Clay)',amount:2040},{year:2019,month:9,rawName:'Ground Crew (Ledric)',amount:120},{year:2019,month:9,rawName:'Ground Crew (John)',amount:145},
  {year:2019,month:10,rawName:'Foreman Labor (Dale )',amount:4910},{year:2019,month:10,rawName:'Groundcrew (Amy)',amount:2401.25},{year:2019,month:10,rawName:'Groundcrew (D. Walker)',amount:400},{year:2019,month:10,rawName:'Ground Crew (D. Smith)',amount:2240},{year:2019,month:10,rawName:'Ground Crew (E. Moore)',amount:312.5},
  {year:2019,month:11,rawName:'Forman Labor (Dale )',amount:3525},{year:2019,month:11,rawName:'Groundcrew (George)',amount:1150},{year:2019,month:11,rawName:'Groundcrew (Daniel)',amount:550},{year:2019,month:11,rawName:'Ground Crew (Clay)',amount:1560},{year:2019,month:11,rawName:'Ground Crew (Amy )',amount:605},
  {year:2019,month:12,rawName:'Foreman Labor (Dale )',amount:3025},{year:2019,month:12,rawName:'Groundcrew (Amy Lusby)',amount:440},{year:2019,month:12,rawName:'Grouncrew (Daniel Walker)',amount:750},{year:2019,month:12,rawName:'Ground Crew (Clay Smith)',amount:420},{year:2019,month:12,rawName:'Ground Crew (George Lander)',amount:350},
  // 2020
  {year:2020,month:1,rawName:'Foreman Labor (Dale )',amount:4425},{year:2020,month:1,rawName:'Ground Crew (Clay)',amount:120},
  {year:2020,month:2,rawName:'Forman Labor (Dale )',amount:3425},{year:2020,month:2,rawName:'Climber (Scot Ray )',amount:300},{year:2020,month:2,rawName:'Ground Crew (George )',amount:800},
  {year:2020,month:3,rawName:'Foreman Labor (Dale )',amount:4400},{year:2020,month:3,rawName:'Ground Crew (Stacy )',amount:0},
  {year:2020,month:4,rawName:'Foreman Labor (Dale )',amount:2112},{year:2020,month:4,rawName:'ground crew (Amy)',amount:110},{year:2020,month:4,rawName:'ground crew (George)',amount:325},{year:2020,month:4,rawName:'groundcrew (Daniel)',amount:200},
  {year:2020,month:5,rawName:'Foreman Labor (Dale )',amount:2325},{year:2020,month:5,rawName:'ground crew kris belk)',amount:200},{year:2020,month:5,rawName:'groundcrew (Stacy Moore)',amount:1420},
  {year:2020,month:6,rawName:'Foerman Labor (Dale )',amount:2225},{year:2020,month:6,rawName:'Groundcrew (Amy)',amount:750},{year:2020,month:6,rawName:'Groundcrew (Daniel)',amount:2750},{year:2020,month:6,rawName:'Ground Crew (Stacy )',amount:1840},{year:2020,month:6,rawName:'groundcrew(George)',amount:750},
  {year:2020,month:7,rawName:'Foreman Labor (Dale )',amount:3300},{year:2020,month:7,rawName:'Groundcrew (Amy)',amount:1620},{year:2020,month:7,rawName:'Groundcrew (Daniel)',amount:2450},{year:2020,month:7,rawName:'Ground Crew (george)',amount:640},{year:2020,month:7,rawName:'Ground Crew (stacy)',amount:1140},
  {year:2020,month:8,rawName:'Foreman Labor (Dale )',amount:4400},{year:2020,month:8,rawName:'Ground Crew (stacy)',amount:2850},
  {year:2020,month:9,rawName:'Foreman Labor (Dale )',amount:3750},{year:2020,month:9,rawName:'Ground Crew (Stacy)',amount:1920},
  {year:2020,month:10,rawName:'Foreman (Dale )',amount:6050},{year:2020,month:10,rawName:'Ground Crew (Amy)',amount:1380},{year:2020,month:10,rawName:'Groundcrew (Daniel)',amount:1650},{year:2020,month:10,rawName:'Groundcrew (Stacy)',amount:3305},
  {year:2020,month:11,rawName:'Foreman Labor (Dale )',amount:2550},{year:2020,month:11,rawName:'Ground Crew (Albert)',amount:240},{year:2020,month:11,rawName:'Groundcrew (Amy)',amount:575},{year:2020,month:11,rawName:'Groundcrew (Daniel)',amount:1250},{year:2020,month:11,rawName:'Ground Crew (Stacy)',amount:1965},
  {year:2020,month:12,rawName:'Foreman Labor (Dale )',amount:1830},{year:2020,month:12,rawName:'groundcrew(amy)',amount:1045},{year:2020,month:12,rawName:'Groundcrew(daniel)',amount:1187},{year:2020,month:12,rawName:'Ground Crew (Stacy)',amount:1920},
  // 2021
  {year:2021,month:1,rawName:'Foreman Labor (Dale )',amount:4025},{year:2021,month:1,rawName:'groundcrew(amy)',amount:550},{year:2021,month:1,rawName:'Groundcrew(daniel)',amount:1300},{year:2021,month:1,rawName:'Ground Crew (Coltin)',amount:400},
  {year:2021,month:2,rawName:'Foreman Labor (Dale )',amount:3621.66},{year:2021,month:2,rawName:'groundcrew(amy)',amount:700},{year:2021,month:2,rawName:'Groundcrew(daniel)',amount:1500},{year:2021,month:2,rawName:'Ground Crew (Robert N)',amount:535},
  {year:2021,month:3,rawName:'Foreman Labor (Dale )',amount:4450},{year:2021,month:3,rawName:'groundcrew(amy)',amount:1075},{year:2021,month:3,rawName:'Groundcrew(daniel)',amount:2580},{year:2021,month:3,rawName:'Ground Crew (Darrell)',amount:1395},{year:2021,month:3,rawName:'Ground Crew (Robert Nickle)',amount:250},
  {year:2021,month:4,rawName:'Foreman Labor (Dale )',amount:5050},{year:2021,month:4,rawName:'groundcrew(amy)',amount:2115},{year:2021,month:4,rawName:'Groundcrew(daniel)',amount:2540},{year:2021,month:4,rawName:'Ground Crew (Darrell)',amount:1991.66},
  {year:2021,month:5,rawName:'Foreman Labor (Dale )',amount:5500},{year:2021,month:5,rawName:'groundcrew(amy)',amount:2500},{year:2021,month:5,rawName:'Groundcrew(daniel)',amount:3200},{year:2021,month:5,rawName:'Ground Crew (Dale Tait)',amount:1280},{year:2021,month:5,rawName:'Ground Crew (Darrell)',amount:1575},{year:2021,month:5,rawName:'Ground Crew (Brian)',amount:130},
  {year:2021,month:6,rawName:'Foreman Labor (Dale )',amount:4750},{year:2021,month:6,rawName:'groundcrew(amy)',amount:2015},{year:2021,month:6,rawName:'Groundcrew(daniel)',amount:2800},{year:2021,month:6,rawName:'Ground Crew (Darrell)',amount:950},{year:2021,month:6,rawName:'Ground Crew (JD)',amount:750},{year:2021,month:6,rawName:'Ground Crew (Jeremy)',amount:1195},
  {year:2021,month:7,rawName:'Foreman Labor (Dale )',amount:5150},{year:2021,month:7,rawName:'groundcrew(amy)',amount:2625},{year:2021,month:7,rawName:'Groundcrew(daniel)',amount:2880},{year:2021,month:7,rawName:'Ground Crew (JD)',amount:1200},
  {year:2021,month:8,rawName:'Foreman Labor (Dale )',amount:3650},{year:2021,month:8,rawName:'groundcrew(amy)',amount:2037.5},{year:2021,month:8,rawName:'Groundcrew(daniel)',amount:2114.16},{year:2021,month:8,rawName:'Ground Crew (JD)',amount:790},{year:2021,month:8,rawName:'Ground Crew (dennis)',amount:720},
  {year:2021,month:9,rawName:'Foreman Labor (Dale )',amount:3825},{year:2021,month:9,rawName:'groundcrew(amy)',amount:1725},{year:2021,month:9,rawName:'Groundcrew(daniel)',amount:1430},{year:2021,month:9,rawName:'Ground Crew (Dennis)',amount:1030},
  {year:2021,month:10,rawName:'Foreman Labor (Dale )',amount:5250},{year:2021,month:10,rawName:'groundcrew(amy)',amount:2605},{year:2021,month:10,rawName:'Groundcrew(daniel)',amount:2355},{year:2021,month:10,rawName:'Ground Crew (Dennis)',amount:1725},{year:2021,month:10,rawName:'Ground Crew (Elizabeth)',amount:1265},
  {year:2021,month:11,rawName:'Foreman Labor (Dale )',amount:3475},{year:2021,month:11,rawName:'groundcrew(amy)',amount:750},{year:2021,month:11,rawName:'Groundcrew(daniel)',amount:1400},{year:2021,month:11,rawName:'Ground Crew (Dennis)',amount:1575},
  {year:2021,month:12,rawName:'Foreman Labor (Dale )',amount:4375},{year:2021,month:12,rawName:'groundcrew(amy)',amount:1525},{year:2021,month:12,rawName:'Groundcrew(daniel)',amount:1250},{year:2021,month:12,rawName:'Ground Crew (Dennis)',amount:1425},
  // 2022
  {year:2022,month:1,rawName:'Foreman Labor (Dale )',amount:3450},{year:2022,month:1,rawName:'groundcrew(amy)',amount:825},{year:2022,month:1,rawName:'Groundcrew(daniel)',amount:750},{year:2022,month:1,rawName:'Ground Crew (Dennis R)',amount:120},
  {year:2022,month:2,rawName:'Foreman Labor (Dale )',amount:3450},{year:2022,month:2,rawName:'groundcrew(amy)',amount:1100},{year:2022,month:2,rawName:'Groundcrew(daniel)',amount:1200},
  {year:2022,month:3,rawName:'Foreman Labor (Dale )',amount:4450},{year:2022,month:3,rawName:'groundcrew(amy)',amount:1950},{year:2022,month:3,rawName:'Groundcrew(daniel)',amount:2100},{year:2022,month:3,rawName:'Ground Crew (Trace)',amount:700},
  {year:2022,month:4,rawName:'Foreman Labor (Dale )',amount:4750},{year:2022,month:4,rawName:'groundcrew(amy)',amount:1850},{year:2022,month:4,rawName:'Groundcrew(daniel)',amount:2100},{year:2022,month:4,rawName:'Ground Crew (Trace)',amount:1200},
  {year:2022,month:5,rawName:'Foreman Labor (Dale )',amount:3750},{year:2022,month:5,rawName:'groundcrew(amy)',amount:1650},{year:2022,month:5,rawName:'Groundcrew(daniel)',amount:2200},{year:2022,month:5,rawName:'Ground Crew (Dale Tait)',amount:1050},{year:2022,month:5,rawName:'Ground Crew (Trace)',amount:700},
  {year:2022,month:6,rawName:'Foreman Labor (Dale )',amount:3600},{year:2022,month:6,rawName:'groundcrew(amy)',amount:1500},{year:2022,month:6,rawName:'Groundcrew(daniel)',amount:1700},{year:2022,month:6,rawName:'Ground Crew (Dale Tait)',amount:1380},{year:2022,month:6,rawName:'Ground Crew (Darrell)',amount:600},
  {year:2022,month:7,rawName:'Foreman Labor (Dale )',amount:2800},{year:2022,month:7,rawName:'groundcrew(amy)',amount:810},{year:2022,month:7,rawName:'Groundcrew(daniel)',amount:1200},{year:2022,month:7,rawName:'Ground Crew (Dale Tait)',amount:400},{year:2022,month:7,rawName:'Ground Crew (Darrell)',amount:460},
  {year:2022,month:8,rawName:'Foreman Labor (Dale )',amount:2310},{year:2022,month:8,rawName:'groundcrew(amy)',amount:600},{year:2022,month:8,rawName:'Groundcrew(daniel)',amount:680},{year:2022,month:8,rawName:'Ground Crew (Darrell)',amount:600},
  {year:2022,month:9,rawName:'Foreman Labor (Dale )',amount:5600},{year:2022,month:9,rawName:'groundcrew(amy)',amount:2600},{year:2022,month:9,rawName:'Groundcrew(daniel)',amount:2700},{year:2022,month:9,rawName:'Ground Crew (Dale tait)',amount:2495},{year:2022,month:9,rawName:'Ground Crew (Darrell)',amount:800},
  {year:2022,month:10,rawName:'Foreman Labor (Dale )',amount:5350},{year:2022,month:10,rawName:'groundcrew(amy)',amount:2200},{year:2022,month:10,rawName:'Groundcrew(daniel)',amount:2200},{year:2022,month:10,rawName:'Ground Crew (dale tait)',amount:740},{year:2022,month:10,rawName:'Ground Crew (Andrew Musa)',amount:250},
  {year:2022,month:11,rawName:'Foreman Labor (Dale )',amount:3200},{year:2022,month:11,rawName:'groundcrew(amy)',amount:1200},{year:2022,month:11,rawName:'Groundcrew(daniel)',amount:1200},
  {year:2022,month:12,rawName:'Foreman Labor (Dale )',amount:4600},{year:2022,month:12,rawName:'groundcrew(amy)',amount:2100},{year:2022,month:12,rawName:'Groundcrew(daniel)',amount:1500},{year:2022,month:12,rawName:'Ground Crew (bryer)',amount:445},
  // 2023
  {year:2023,month:1,rawName:'Foreman Labor (Dale )',amount:2850},{year:2023,month:1,rawName:'groundcrew(amy)',amount:450},{year:2023,month:1,rawName:'Groundcrew(daniel)',amount:600},{year:2023,month:1,rawName:'Ground Crew (bryer)',amount:330},
  {year:2023,month:2,rawName:'Foreman Labor (Dale )',amount:4200},{year:2023,month:2,rawName:'groundcrew(amy)',amount:1800},{year:2023,month:2,rawName:'Groundcrew(daniel)',amount:2100},{year:2023,month:2,rawName:'Ground Crew (Bryer)',amount:1520},{year:2023,month:2,rawName:'Ground Crew (Jared)',amount:125},
  {year:2023,month:3,rawName:'Foreman Labor (Dale )',amount:4200},{year:2023,month:3,rawName:'groundcrew(amy)',amount:1800},{year:2023,month:3,rawName:'Groundcrew(daniel)',amount:2400},{year:2023,month:3,rawName:'Ground Crew (Bryer)',amount:500},
  {year:2023,month:4,rawName:'Foreman Labor (Dale )',amount:4950},{year:2023,month:4,rawName:'groundcrew(amy)',amount:2400},{year:2023,month:4,rawName:'Groundcrew(daniel)',amount:2700},{year:2023,month:4,rawName:'Ground Crew (Perry)',amount:290},
  {year:2023,month:5,rawName:'Foreman Labor (Dale )',amount:3400},{year:2023,month:5,rawName:'groundcrew(amy)',amount:1200},{year:2023,month:5,rawName:'Groundcrew(daniel)',amount:1600},
  {year:2023,month:6,rawName:'Foreman Labor (Dale )',amount:4600},{year:2023,month:6,rawName:'groundcrew(amy)',amount:1755},{year:2023,month:6,rawName:'Groundcrew(daniel)',amount:2400},{year:2023,month:6,rawName:'Ground Crew (Brandon Thomas)',amount:300},
  {year:2023,month:7,rawName:'Foreman Labor (Dale )',amount:5700},{year:2023,month:7,rawName:'groundcrew(amy)',amount:2400},{year:2023,month:7,rawName:'Groundcrew(daniel)',amount:2700},
  {year:2023,month:8,rawName:'Foreman Labor (Dale )',amount:4200},{year:2023,month:8,rawName:'groundcrew(amy)',amount:1650},{year:2023,month:8,rawName:'Groundcrew(daniel)',amount:1800},{year:2023,month:8,rawName:'Ground Crew (lizzy)',amount:1335},
  {year:2023,month:9,rawName:'Foreman Labor (Dale )',amount:2460},{year:2023,month:9,rawName:'groundcrew(amy)',amount:600},{year:2023,month:9,rawName:'Groundcrew(daniel)',amount:855},{year:2023,month:9,rawName:'Ground Crew (Lizzy)',amount:375},
  {year:2023,month:10,rawName:'Foreman Labor (Dale )',amount:4650},{year:2023,month:10,rawName:'groundcrew(amy)',amount:1800},{year:2023,month:10,rawName:'Groundcrew(daniel)',amount:2400},{year:2023,month:10,rawName:'Ground Crew (bryer)',amount:1400},{year:2023,month:10,rawName:'Ground Crew (lizzy)',amount:500},
  {year:2023,month:11,rawName:'Foreman Labor (Dale )',amount:3150},{year:2023,month:11,rawName:'groundcrew(amy)',amount:900},{year:2023,month:11,rawName:'Groundcrew(daniel)',amount:1500},{year:2023,month:11,rawName:'groundcrew(bryer)',amount:505},{year:2023,month:11,rawName:'groundcrew(lizzy)',amount:650},
  {year:2023,month:12,rawName:'Foreman Labor (Dale )',amount:2500},{year:2023,month:12,rawName:'groundcrew(amy)',amount:900},{year:2023,month:12,rawName:'Groundcrew(daniel)',amount:800},{year:2023,month:12,rawName:'Ground Crew (byar)',amount:120},
  // 2024
  {year:2024,month:1,rawName:'Foreman Labor (Dale )',amount:2500},{year:2024,month:1,rawName:'groundcrew(amy)',amount:375},{year:2024,month:1,rawName:'Groundcrew(daniel)',amount:600},{year:2024,month:1,rawName:'Ground Crew (Lizzy)',amount:375},
  {year:2024,month:2,rawName:'Foreman Labor (Dale )',amount:3050},{year:2024,month:2,rawName:'groundcrew(amy)',amount:1050},{year:2024,month:2,rawName:'Groundcrew(daniel)',amount:1200},{year:2024,month:2,rawName:'Ground Crew (Darrell)',amount:600},{year:2024,month:2,rawName:'Ground Crew (B Haas)',amount:120},
  {year:2024,month:3,rawName:'Foreman Labor (Dale )',amount:4500},{year:2024,month:3,rawName:'groundcrew(amy)',amount:1800},{year:2024,month:3,rawName:'Groundcrew(daniel)',amount:2400},{year:2024,month:3,rawName:'Ground Crew (Darrell)',amount:1500},
  {year:2024,month:4,rawName:'Foreman Labor (Dale )',amount:3950},{year:2024,month:4,rawName:'groundcrew(amy)',amount:1350},{year:2024,month:4,rawName:'Groundcrew(daniel)',amount:1800},{year:2024,month:4,rawName:'Ground Crew (Darrell)',amount:900},
  {year:2024,month:5,rawName:'Foreman Labor (Dale )',amount:4050},{year:2024,month:5,rawName:'groundcrew(amy)',amount:1800},{year:2024,month:5,rawName:'Groundcrew(daniel)',amount:2200},{year:2024,month:5,rawName:'Ground Crew (Darrell Kraft)',amount:980},
  {year:2024,month:6,rawName:'Foreman Labor (Dale )',amount:3600},{year:2024,month:6,rawName:'groundcrew(amy)',amount:1500},{year:2024,month:6,rawName:'Groundcrew(daniel)',amount:2000},{year:2024,month:6,rawName:'Ground Crew (Darrell)',amount:800},
  {year:2024,month:7,rawName:'Foreman Labor (Dale )',amount:4350},{year:2024,month:7,rawName:'groundcrew(amy)',amount:2100},{year:2024,month:7,rawName:'Groundcrew(daniel)',amount:2400},{year:2024,month:7,rawName:'Ground Crew (Darrell)',amount:1200},
  {year:2024,month:8,rawName:'Foreman Labor (Dale )',amount:3650},{year:2024,month:8,rawName:'groundcrew(amy)',amount:1500},{year:2024,month:8,rawName:'Groundcrew(daniel)',amount:2520},{year:2024,month:8,rawName:'Ground Crew (Darrell)',amount:1050},
  {year:2024,month:9,rawName:'Foreman Labor (Dale )',amount:2645},{year:2024,month:9,rawName:'groundcrew(amy)',amount:1110},{year:2024,month:9,rawName:'Groundcrew(daniel)',amount:1400},{year:2024,month:9,rawName:'Ground Crew (Darrell)',amount:1265},{year:2024,month:9,rawName:'Ground Crew (bryer h)',amount:600},
  {year:2024,month:10,rawName:'Foreman Labor (Dale )',amount:3500},{year:2024,month:10,rawName:'groundcrew(amy)',amount:1500},{year:2024,month:10,rawName:'Groundcrew(daniel)',amount:2000},{year:2024,month:10,rawName:'Ground Crew (bryer)',amount:1365},
  {year:2024,month:11,rawName:'Foreman Labor (Dale )',amount:2500},{year:2024,month:11,rawName:'groundcrew(amy)',amount:500},{year:2024,month:11,rawName:'Groundcrew(daniel)',amount:1000},{year:2024,month:11,rawName:'groundcrew(bryer)',amount:150},
  // 2025
  {year:2025,month:1,rawName:'Foreman Labor (Dale )',amount:2700},
  {year:2025,month:2,rawName:'Foreman Labor (Dale )',amount:3745},{year:2025,month:2,rawName:'groundcrew(amy)',amount:1215},{year:2025,month:2,rawName:'Groundcrew(daniel)',amount:2080},{year:2025,month:2,rawName:'Ground Crew (B Haas)',amount:720},
  {year:2025,month:3,rawName:'Foreman Labor (Dale )',amount:4800},{year:2025,month:3,rawName:'groundcrew(amy)',amount:1920},{year:2025,month:3,rawName:'Groundcrew(daniel)',amount:2700},{year:2025,month:3,rawName:'Ground Crew (Bryer)',amount:600},{year:2025,month:3,rawName:'Groundcrew(Jarred)',amount:700},
  {year:2025,month:4,rawName:'Foreman Labor (Dale )',amount:5950},{year:2025,month:4,rawName:'groundcrew(amy)',amount:2850},{year:2025,month:4,rawName:'Groundcrew(daniel)',amount:3000},{year:2025,month:4,rawName:'Climber(Troy)',amount:2450},{year:2025,month:4,rawName:'Ground Crew (Jarred)',amount:1200},
  {year:2025,month:5,rawName:'Foreman Labor (Dale )',amount:4200},{year:2025,month:5,rawName:'groundcrew(amy)',amount:1800},{year:2025,month:5,rawName:'Groundcrew(daniel)',amount:2400},{year:2025,month:5,rawName:'Ground Crew (Jarred)',amount:1050},
  {year:2025,month:6,rawName:'Foreman Labor (Dale )',amount:5200},{year:2025,month:6,rawName:'groundcrew(amy)',amount:2200},{year:2025,month:6,rawName:'Groundcrew(daniel)',amount:2800},{year:2025,month:6,rawName:'Ground Crew (Jarred)',amount:1300},{year:2025,month:6,rawName:'Ground Crew (Tori)',amount:105},
  {year:2025,month:7,rawName:'Foreman Labor (Dale )',amount:3800},{year:2025,month:7,rawName:'groundcrew(amy)',amount:1800},{year:2025,month:7,rawName:'Groundcrew(daniel)',amount:2100},
  {year:2025,month:8,rawName:'Foreman Labor (Dale )',amount:4700},{year:2025,month:8,rawName:'groundcrew(amy)',amount:2100},{year:2025,month:8,rawName:'Groundcrew(daniel)',amount:2600},
  {year:2025,month:9,rawName:'Foreman Labor (Dale )',amount:3550},{year:2025,month:9,rawName:'groundcrew(amy)',amount:1800},{year:2025,month:9,rawName:'Groundcrew(daniel)',amount:1500},
  {year:2025,month:10,rawName:'Foreman Labor (Dale )',amount:4500},{year:2025,month:10,rawName:'groundcrew(amy)',amount:2250},{year:2025,month:10,rawName:'Groundcrew(daniel)',amount:1800},{year:2025,month:10,rawName:'Ground Crew (John)',amount:300},
  {year:2025,month:11,rawName:'Foreman Labor (Dale )',amount:3205},{year:2025,month:11,rawName:'groundcrew(amy)',amount:1485},{year:2025,month:11,rawName:'Groundcrew(daniel)',amount:1185},{year:2025,month:11,rawName:'groundcrew(john walker)',amount:215},
  {year:2025,month:12,rawName:'Foreman Labor (Dale )',amount:2800},{year:2025,month:12,rawName:'groundcrew(amy)',amount:1000},{year:2025,month:12,rawName:'Groundcrew(daniel)',amount:600},{year:2025,month:12,rawName:'Ground Crew (Adam)',amount:120},
  // 2026
  {year:2026,month:1,rawName:'Foreman Labor (Dale )',amount:2950},{year:2026,month:1,rawName:'groundcrew(amy)',amount:1350},{year:2026,month:1,rawName:'Groundcrew(daniel)',amount:1440},{year:2026,month:1,rawName:'Ground Crew (Chris)',amount:450},
  {year:2026,month:2,rawName:'Foreman Labor (Dale )',amount:3745},{year:2026,month:2,rawName:'groundcrew(amy)',amount:1215},{year:2026,month:2,rawName:'Groundcrew(daniel)',amount:2080},{year:2026,month:2,rawName:'Ground Crew (C Breland)',amount:1800},
  {year:2026,month:3,rawName:'Foreman Labor (Dale )',amount:5490},{year:2026,month:3,rawName:'groundcrew(amy)',amount:1920},{year:2026,month:3,rawName:'Groundcrew(daniel)',amount:2910},{year:2026,month:3,rawName:'Ground Crew (Chris)',amount:2280},
];

function getWorkingDays(year: number, month: number): number[] {
  const days: number[] = [];
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, month - 1, d).getDay();
    if (dow !== 0) days.push(d); // skip sundays
  }
  return days;
}

async function main() {
  console.log('=== Seed Crew Daily Logs (All Years) ===\n');

  if (!process.env.SUPABASE_SERVICE_KEY) {
    console.error('ERROR: SUPABASE_SERVICE_KEY not found');
    process.exit(1);
  }

  // Get crew members from DB
  const { data: members, error: membersError } = await supabase
    .from('crew_members')
    .select('id, name, daily_rate');

  if (membersError || !members?.length) {
    console.error('No crew members found:', membersError?.message);
    process.exit(1);
  }

  const nameToMember: Record<string, { id: string; daily_rate: number }> = {};
  for (const m of members) {
    nameToMember[m.name] = { id: m.id, daily_rate: m.daily_rate };
  }
  console.log(`Found ${members.length} crew members`);

  // Clear existing logs
  console.log('Clearing crew_daily_log...');
  const { error: clearError } = await supabase
    .from('crew_daily_log')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000');
  if (clearError) console.warn('Warning:', clearError.message);

  // Process each monthly pay entry into daily logs
  const allLogs: { crew_member_id: string; date: string; worked: boolean }[] = [];

  for (const entry of rawCrewPay) {
    const name = normalizeName(entry.rawName);
    if (!name) continue;

    const member = nameToMember[name];
    if (!member) {
      // Skip - not in our crew_members table
      continue;
    }

    // Calculate approximate days worked from total pay / daily rate
    const daysWorked = Math.round(entry.amount / member.daily_rate);
    if (daysWorked <= 0) continue;

    // Distribute across working days in the month
    const workingDays = getWorkingDays(entry.year, entry.month);
    const daysToAssign = Math.min(daysWorked, workingDays.length);

    // Pick evenly spaced days
    const step = workingDays.length / daysToAssign;
    for (let i = 0; i < daysToAssign; i++) {
      const dayIdx = Math.min(Math.floor(i * step), workingDays.length - 1);
      const day = workingDays[dayIdx];
      const dateStr = `${entry.year}-${String(entry.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      allLogs.push({ crew_member_id: member.id, date: dateStr, worked: true });
    }
  }

  // Deduplicate (same member + same date)
  const seen = new Set<string>();
  const uniqueLogs = allLogs.filter((l) => {
    const key = `${l.crew_member_id}_${l.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`Generated ${uniqueLogs.length} unique daily log entries`);

  // Insert in batches
  const batchSize = 500;
  for (let i = 0; i < uniqueLogs.length; i += batchSize) {
    const batch = uniqueLogs.slice(i, i + batchSize);
    const { error } = await supabase.from('crew_daily_log').insert(batch);
    if (error) {
      console.error(`Error batch ${Math.floor(i / batchSize) + 1}:`, error.message);
    } else {
      console.log(`  Batch ${Math.floor(i / batchSize) + 1}: ${batch.length} records`);
    }
  }

  // Summary by year
  console.log('\n=== Summary ===');
  for (const y of [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]) {
    const yearLogs = uniqueLogs.filter((l) => l.date.startsWith(String(y)));
    console.log(`  ${y}: ${yearLogs.length} work days logged`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
