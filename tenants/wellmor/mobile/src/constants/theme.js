/**
 * WellMor Premium Design System
 *
 * Palette: Navy anchors the brand. WellMor green is the selective accent.
 * Surfaces use warm whites and soft ivory tones — never flat gray.
 * Typography is clear and hierarchical. Spacing is generous and intentional.
 */

export const colors = {
  // ─── Brand ───────────────────────────────────────────
  navy:       '#0B1A2E',
  navyLight:  '#142640',
  navySoft:   '#1E3355',

  // WellMor brand green — used sparingly as a premium accent
  brand:      '#2E8B57',
  brandLight: '#E8F5EE',
  brandDark:  '#1F6B42',

  // ─── Accent ──────────────────────────────────────────
  accent:     '#2563EB',    // a refined blue for interactive elements
  accentLight:'#EFF6FF',
  accentSoft: '#DBEAFE',

  // ─── Status ──────────────────────────────────────────
  green:      '#16A34A',
  greenBg:    '#F0FDF4',
  red:        '#DC2626',
  redBg:      '#FEF2F2',
  amber:      '#D97706',
  amberBg:    '#FFFBEB',

  // ─── Neutrals (warm-shifted) ─────────────────────────
  white:      '#FFFFFF',
  ivory:      '#FAFBFC',
  gray50:     '#F8F9FB',
  gray100:    '#F1F3F5',
  gray150:    '#EAEDF0',
  gray200:    '#DFE3E8',
  gray300:    '#C4CDD5',
  gray400:    '#919EAB',
  gray500:    '#637381',
  gray600:    '#454F5B',
  gray700:    '#333D47',
  gray800:    '#212B36',

  // ─── Surfaces ────────────────────────────────────────
  background: '#F4F6F8',
  card:       '#FFFFFF',
  cardBorder: 'rgba(0,0,0,0.04)',

  // ─── Platform brand colors ──────────────────────────
  linkedin:   '#0A66C2',
  instagram:  '#E4405F',
  threads:    '#000000',
  x:          '#000000',
};

export const spacing = {
  xs:  4,
  sm:  8,
  md:  16,
  lg:  24,
  xl:  32,
  xxl: 48,
};

export const fontSize = {
  xs:   11,
  sm:   13,
  base: 15,
  md:   16,
  lg:   18,
  xl:   22,
  xxl:  28,
  hero: 32,
};

export const fontWeight = {
  regular:  '400',
  medium:   '500',
  semibold: '600',
  bold:     '700',
};

export const lineHeight = {
  tight:  1.2,
  normal: 1.4,
  relaxed: 1.6,
};

export const borderRadius = {
  sm:   8,
  md:   12,
  lg:   16,
  xl:   20,
  xxl:  24,
  full: 999,
};

// Consistent shadow levels for depth
export const shadows = {
  sm: {
    shadowColor: '#0B1A2E',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  md: {
    shadowColor: '#0B1A2E',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  lg: {
    shadowColor: '#0B1A2E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 5,
  },
};
