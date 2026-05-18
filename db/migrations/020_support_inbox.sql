-- ---------------------------------------------------------------------------
-- 020_support_inbox.sql — inbound support email threading
-- ---------------------------------------------------------------------------
-- Backs the admin Support page (/admin/support). Populated by the inbound
-- email webhook (a separate worker that consumes Resend / Postmark inbound
-- events). The admin UI can read threads, view messages, reply, and change
-- thread status even before the webhook is wired — the tables just stay
-- empty until inbound mail starts flowing.

CREATE TABLE IF NOT EXISTS support_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  from_name TEXT,
  from_email TEXT NOT NULL,
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved')),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_threads_status ON support_threads(status);
CREATE INDEX IF NOT EXISTS idx_support_threads_last_message ON support_threads(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_threads_tenant ON support_threads(tenant_id);

CREATE TABLE IF NOT EXISTS support_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_email TEXT,
  to_email TEXT,
  subject TEXT,
  body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_messages_thread ON support_messages(thread_id, created_at);
