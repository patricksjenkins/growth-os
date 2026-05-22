/**
 * Growth OS — Marketing Taxonomy
 *
 * Single source of truth for the FGA platform-owner "Module Promo
 * Generator". The frontend MarketingStudio page mirrors this exact
 * shape via marketing-site/src/lib/marketingTaxonomy.ts; if you add
 * a module or niche here, update the .ts mirror too.
 *
 * - MODULES: the 15 official FGA product modules (Growth = pick 7, Scale = all)
 * - NICHE_CATEGORIES: the 6 broad category buckets we target
 * - NICHES_BY_CATEGORY: every micro-business (1-5 employee) target inside each
 *
 * Constraints: ALL niches here must be appropriate for micro-businesses.
 * Anything that meaningfully requires >5 employees should NOT be listed.
 */

const MODULES = [
  { id: 1,  key: 'voice_receptionist',  name: 'AI Voice Receptionist',  tier: 'scale' },
  { id: 2,  key: 'chat_agent',          name: 'AI Chat Agent',          tier: 'both'  },
  { id: 3,  key: 'website',             name: 'Done-For-You Website',   tier: 'both'  },
  { id: 4,  key: 'lead_capture',        name: 'Lead Capture & CRM',     tier: 'both'  },
  { id: 5,  key: 'speed_to_lead',       name: 'Speed-to-Lead',          tier: 'both'  },
  { id: 6,  key: 'missed_call_textback',name: 'Missed Call Text-Back',  tier: 'both'  },
  { id: 7,  key: 'follow_up_sequences', name: 'Follow-Up Sequences',    tier: 'both'  },
  { id: 8,  key: 'content_engine',      name: 'Content Engine',         tier: 'both'  },
  { id: 9,  key: 'content_approval',    name: 'Content Approval & Scheduling', tier: 'both' },
  { id: 10, key: 'review_requests',     name: 'Review Requests',        tier: 'both'  },
  { id: 11, key: 'branded_app',         name: 'Branded Mobile App',     tier: 'both'  },
  { id: 12, key: 'referral_engine',     name: 'Referral Engine',        tier: 'both'  },
  { id: 13, key: 'referral_outreach',   name: 'Referral Partner Outreach', tier: 'both' },
  { id: 14, key: 'prospecting_engine',  name: 'Prospecting Engine',     tier: 'both'  },
  { id: 15, key: 'lead_scoring',        name: 'Lead Scoring',           tier: 'both'  },
];

const NICHE_CATEGORIES = [
  { key: 'home_property',         name: 'Home & Property' },
  { key: 'skilled_trades',        name: 'Skilled Trades' },
  { key: 'professional_services', name: 'Professional Services' },
  { key: 'health_wellness',       name: 'Health & Wellness' },
  { key: 'auto_marine_pets',      name: 'Auto, Marine & Pets' },
  { key: 'retail_makers',         name: 'Retail & Makers' },
];

const NICHES_BY_CATEGORY = {
  home_property: [
    'Tree Services', 'Landscaping', 'Pressure Washing',
    'Cleaning Services', 'Pest Control', 'Pool Services',
  ],
  skilled_trades: [
    'Plumbing', 'Electrical', 'HVAC',
    'Roofing', 'General Contractors', 'Painting',
  ],
  professional_services: [
    'Benefits Consulting', 'Insurance', 'Real Estate',
    'Financial Planning', 'Business Coaching', 'Tax Preparation',
  ],
  health_wellness: [
    'Personal Training', 'Chiropractic', 'Med Spa',
    'Dental', 'Physical Therapy', 'Massage Therapy',
  ],
  auto_marine_pets: [
    'Auto Repair', 'Auto Detailing', 'Towing',
    'Boat Services', 'RV Repair', 'Tire Shops',
    'Dog Grooming', 'Pet Sitting', 'Veterinary',
    'Dog Training', 'Pet Boarding', 'Mobile Vet',
  ],
  retail_makers: [
    'Etsy Sellers', 'Specialty Food', 'E-commerce Stores',
    'Boutique Retail', 'Farmers Market Vendors', 'Subscription Boxes',
  ],
};

// Flatten helper — useful for validators that need "is this niche
// in any category".
function allNiches() {
  return Object.values(NICHES_BY_CATEGORY).flat();
}

// Look up a category by niche string (case-insensitive). Returns
// { categoryKey, categoryName } or null if not found. Used by the
// backend to enforce that any incoming niche actually belongs to a
// declared category — no free-text injection.
function findCategoryForNiche(niche) {
  if (!niche) return null;
  const needle = String(niche).trim().toLowerCase();
  for (const cat of NICHE_CATEGORIES) {
    const list = NICHES_BY_CATEGORY[cat.key] || [];
    if (list.some(n => n.toLowerCase() === needle)) {
      return { categoryKey: cat.key, categoryName: cat.name };
    }
  }
  return null;
}

function findModule(idOrKey) {
  if (idOrKey == null) return null;
  if (typeof idOrKey === 'number') {
    return MODULES.find(m => m.id === idOrKey) || null;
  }
  const key = String(idOrKey).toLowerCase();
  return MODULES.find(m => m.key === key || String(m.id) === key) || null;
}

module.exports = {
  MODULES,
  NICHE_CATEGORIES,
  NICHES_BY_CATEGORY,
  allNiches,
  findCategoryForNiche,
  findModule,
};
