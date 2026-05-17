-- Migration 018: voice_calls + tenant_config seeds for Module 9 (AI Voice Receptionist)
--
-- Per-tenant log of every AI-handled phone call. We persist ONLY the text
-- transcript — never the audio recording. Privacy by design eliminates
-- two-party-consent state liability and reduces storage to ~few KB per call.
--
-- Sales claim 9.4 "Captures caller name, phone, service, urgency, address;
--   creates lead row" — implementation: voice-receptionist agent inserts
--   into leads after Vapi end-of-call extraction; captured_lead_id back-links here.
-- Sales claim 9.5 "Full text transcript SMS to owner immediately — no audio
--   recordings stored" — implementation: transcript TEXT column; NO recording_url.
-- Sales claim 9.6 "Emergency keyword detection pages owner immediately" —
--   implementation: emergency_flagged + tenant_config.voice_receptionist_emergency_keywords.

CREATE TABLE IF NOT EXISTS voice_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Twilio call SID — canonical identifier; unique so the same webhook fire
  -- never inserts twice (Twilio retries on 5xx).
  twilio_call_sid TEXT UNIQUE NOT NULL,
  -- Vapi.ai assistant call ID for tracing the conversation in their dashboard.
  vapi_call_id TEXT,
  -- Caller's phone number (E.164 normalized).
  caller_phone TEXT NOT NULL,
  -- Total call duration in seconds (Twilio's value at hangup).
  duration_seconds INTEGER,
  -- Plain-text transcript of the full conversation. NEVER audio.
  transcript TEXT,
  -- AI classification of the call outcome.
  -- One of: new_lead | existing_customer | spam | wrong_number | emergency | other
  classification TEXT,
  -- If the AI captured a lead from this call, the resulting leads.id.
  captured_lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  -- True if any emergency keyword fired during the conversation; raises the
  -- owner notification to high priority + URGENT prefix.
  emergency_flagged BOOLEAN NOT NULL DEFAULT FALSE,
  -- Whether the owner was actually pinged with the transcript SMS.
  owner_notified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voice_calls_tenant_created
  ON voice_calls(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_voice_calls_captured_lead
  ON voice_calls(captured_lead_id)
  WHERE captured_lead_id IS NOT NULL;

-- RLS: tenants only see their own voice_calls.
ALTER TABLE voice_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON voice_calls;
CREATE POLICY tenant_isolation ON voice_calls
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Service role bypass (worker + webhooks use the service-role key, which
-- bypasses RLS by design).

-- ---------------------------------------------------------------------------
-- Tenant usage column for the 200-min/mo Scale-tier cap
-- ---------------------------------------------------------------------------
-- The voice-receptionist agent increments voice_minutes_used after each
-- call. The webhook checks the cap before handing off to Vapi — at cap,
-- the call falls back to missed-call text-back instead of burning more
-- voice minutes.
ALTER TABLE IF EXISTS tenant_usage
  ADD COLUMN IF NOT EXISTS voice_minutes_used INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Default tenant_config keys for Voice Receptionist
-- ---------------------------------------------------------------------------
-- These are read by the webhook and the voice-ai integration. Defaults
-- live in code (core/config.js getConfig fallback) — this comment block
-- documents the keys that the wizard step 8.5 will write per-tenant.
--
-- voice_receptionist_enabled       BOOL    default true when module on
-- voice_receptionist_forward_to    TEXT    owner's personal/business phone (E.164)
-- voice_receptionist_ring_count    INT     default 4 (range 0-6)
-- voice_receptionist_voice         TEXT    default 'jennifer' — one of 4 stock voice IDs
-- voice_receptionist_emergency_keywords TEXT[] default ARRAY['burst pipe', 'smoke',
--                                  'gas leak', 'no power', 'flooding', 'no heat']
-- voice_receptionist_minutes_cap   INT     default 200 (Scale tier)
-- voice_receptionist_opening_line  TEXT    optional — overrides "Thanks for calling
--                                  [business name], how can I help?"

-- No seed inserts here — onboarding wizard writes them; agent uses defaults
-- if missing.
