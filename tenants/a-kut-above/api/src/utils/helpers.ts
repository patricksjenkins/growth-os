export const formatPhone = (phone: string): string => {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 10) return `+1${cleaned}`;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;
  return `+${cleaned}`;
};

export const formatCurrency = (amount: number): string => {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
};

export const serviceTypeLabel = (type: string): string => {
  const labels: Record<string, string> = {
    tree_removal: 'Tree Removal',
    trimming: 'Trimming',
    stump_grinding: 'Stump Grinding',
    storm_cleanup: 'Storm Cleanup',
    emergency_removal: 'Emergency Removal',
    debris_haul_off: 'Debris Haul-Off',
  };
  return labels[type] || type;
};

export const leadSourceLabel = (source: string): string => {
  const labels: Record<string, string> = {
    google_search: 'Google Search',
    google_ads: 'Google Ads',
    facebook: 'Facebook',
    instagram: 'Instagram',
    website: 'Website',
    referral_past_customer: 'Referral - Past Customer',
    referral_realtor: 'Referral - Realtor',
    referral_insurance_agent: 'Referral - Insurance Agent',
    word_of_mouth: 'Word of Mouth',
    yard_sign: 'Yard Sign',
    repeat_customer: 'Repeat Customer',
    missed_call_text_back: 'Missed Call Text Back',
    homeadvisor: 'HomeAdvisor',
    other: 'Other',
  };
  return labels[source] || source;
};
