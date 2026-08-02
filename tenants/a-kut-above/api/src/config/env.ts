import dotenv from 'dotenv';

// dotenv v17 doesn't populate process.env — read from parsed object
const parsed = dotenv.config().parsed || {};
const get = (key: string, fallback: string = '') => parsed[key] || process.env[key] || fallback;

export const env = {
  PORT: get('PORT', '3000'),
  NODE_ENV: get('NODE_ENV', 'development'),

  // Supabase
  SUPABASE_URL: get('SUPABASE_URL'),
  SUPABASE_ANON_KEY: get('SUPABASE_ANON_KEY'),
  SUPABASE_SERVICE_KEY: get('SUPABASE_SERVICE_KEY'),

  // Telnyx
  TELNYX_API_KEY: get('TELNYX_API_KEY'),
  TELNYX_PHONE_NUMBER: get('TELNYX_PHONE_NUMBER'),
  TELNYX_MESSAGING_PROFILE_ID: get('TELNYX_MESSAGING_PROFILE_ID'),

  // AI
  ANTHROPIC_API_KEY: get('ANTHROPIC_API_KEY'),
  OPENAI_API_KEY: get('OPENAI_API_KEY'),

  // Business
  BUSINESS_NAME: 'A Kut Above Tree Services',
  GOOGLE_REVIEW_URL: get('GOOGLE_REVIEW_URL'),
  BUSINESS_PHONE: get('BUSINESS_PHONE'),
  BUSINESS_EMAIL: get('BUSINESS_EMAIL'),

  // Email (SMTP for outreach)
  SMTP_HOST: get('SMTP_HOST'),
  SMTP_PORT: parseInt(get('SMTP_PORT', '587')),
  SMTP_USER: get('SMTP_USER'),
  SMTP_PASS: get('SMTP_PASS'),
  SMTP_FROM: get('SMTP_FROM'),

  // Social Media Publishing (Buffer)
  BUFFER_API_KEY: get('BUFFER_API_KEY'),
  BUFFER_CHANNEL_ID: get('BUFFER_CHANNEL_ID'),

  // n8n
  N8N_WEBHOOK_URL: get('N8N_WEBHOOK_URL'),
};
