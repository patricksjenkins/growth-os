/**
 * First Gen Automate — Drip campaign Gmail reply sync
 *
 * Polls patrick@firstgenautomate.com (the FGA Gmail connection in
 * email_connections) for inbound mail from enrolled prospects and routes it:
 *
 *   genuine_reply        -> stop campaign, lead -> 'replied', blue attention item
 *   out_of_office        -> pause enrollment until detected return date (or +7d)
 *   bounce               -> suppress address, stop enrollment, amber attention item
 *   unsubscribe_request  -> suppress address, stop enrollment
 *   auto_reply           -> recorded, campaign continues
 *   ambiguous            -> enrollment -> 'review' + amber attention item (human decides)
 *
 * Classification is DETERMINISTIC-FIRST (Auto-Submitted / Precedence headers,
 * mailer-daemon senders, DSN subjects, OOO subject patterns); Claude is only
 * consulted for messages those rules can't decide. Every inbound is stored in
 * drip_inbound with classification + confidence + reason + actor for audit.
 *
 * Matching is sender-address-first: each enrolled prospect has a unique email,
 * so `From: <prospect>` is the primary deterministic signal. Bounces are
 * matched by searching the DSN body for an enrolled address.
 */

const crypto = require('crypto');
const { createLogger } = require('./logger');
const { FGA_TENANT_ID } = require('./config');
const {
  stopEnrollment, pauseEnrollment, suppress,
} = require('./drip-campaign');

const log = createLogger('drip-gmail');

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

// ---------------------------------------------------------------------------
// OAuth connect (FGA inbox) — signed state, 10-min TTL (same hardening as
// the email-agent routes). The admin drip routes mint the URL; the public
// /api/drip/gmail/callback verifies + stores tokens.
// ---------------------------------------------------------------------------

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function oauthStateSecret() {
  const s = process.env.OAUTH_STATE_SECRET;
  if (s && s.length >= 32) return s;
  return process.env.SUPABASE_SERVICE_ROLE_KEY || 'INSECURE_FALLBACK_DO_NOT_USE_IN_PROD';
}

function signOauthState(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', oauthStateSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyOauthState(stateStr) {
  if (typeof stateStr !== 'string' || !stateStr.includes('.')) return null;
  const [body, sig] = stateStr.split('.', 2);
  const expected = crypto.createHmac('sha256', oauthStateSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (!parsed.iat || Date.now() - parsed.iat > OAUTH_STATE_TTL_MS) return null;
  return parsed;
}

function gmailRedirectUri() {
  const base = process.env.API_URL || 'https://growth-os-production-22b3.up.railway.app';
  return `${base.replace(/\/$/, '')}/api/drip/gmail/callback`;
}

// ---------------------------------------------------------------------------
// Two OAuth clients, one callback.
//
//   'internal' — the original Google Cloud project. Consent screen User type =
//                Internal, so it ONLY accepts @firstgenautomate.com Workspace
//                accounts. A personal @gmail.com gets `403 org_internal`.
//   'external' — a second project whose consent screen is External and whose
//                publishing status is "In production" (verification not
//                required under Google's personal-use exemption). This is the
//                only way to authorize a personal Gmail.
//
// User type is a per-project setting, so one project genuinely cannot do both.
//
// A refresh token is bound to the client_id that minted it — Google rejects a
// refresh presented with a different client's secret. Every connection
// therefore records its `oauth_client`, and ensureValidToken() refreshes with
// THAT client's credentials, never the ambient default.
// ---------------------------------------------------------------------------

const OAUTH_CLIENTS = {
  internal: { idEnv: 'GOOGLE_CLIENT_ID', secretEnv: 'GOOGLE_CLIENT_SECRET' },
  external: { idEnv: 'GOOGLE_EXTERNAL_CLIENT_ID', secretEnv: 'GOOGLE_EXTERNAL_CLIENT_SECRET' },
};

/** Credentials for a client kind. Throws if that client isn't configured. */
function oauthCreds(kind = 'internal') {
  const spec = OAUTH_CLIENTS[kind];
  if (!spec) throw new Error(`Unknown Google OAuth client: ${kind}`);
  const clientId = process.env[spec.idEnv];
  const clientSecret = process.env[spec.secretEnv];
  if (!clientId || !clientSecret) {
    throw new Error(
      kind === 'external'
        ? 'Personal-mailbox sign-in is not configured on the server (GOOGLE_EXTERNAL_CLIENT_ID / GOOGLE_EXTERNAL_CLIENT_SECRET).'
        : `${spec.idEnv} is not configured on the server`,
    );
  }
  return { clientId, clientSecret, kind };
}

/** Which OAuth clients have credentials present. Drives the connect UI. */
function configuredOauthClients() {
  return Object.entries(OAUTH_CLIENTS)
    .filter(([, spec]) => !!process.env[spec.idEnv] && !!process.env[spec.secretEnv])
    .map(([kind]) => kind);
}

/**
 * Auth URL for connecting a Gmail inbox (read-only scope).
 *
 * `purpose` rides in the signed state and tells the callback where to send the
 * browser afterwards:
 *   'drip'    — the primary outreach inbox (redirects to /admin/drip-campaign)
 *   'mailbox' — an additional inbox for invoice scanning (-> /admin/expenses)
 *
 * The scope is unchanged for both: gmail.readonly already permits
 * messages.attachments.get, so adding invoice scanning needs no re-consent.
 */
function buildGmailConnectUrl(purpose = 'drip', clientKind = 'internal') {
  if (purpose !== 'drip' && purpose !== 'mailbox') {
    throw new Error(`Unknown Gmail connect purpose: ${purpose}`);
  }
  const { clientId } = oauthCreds(clientKind);
  // The client kind rides in the SIGNED state so the callback exchanges the
  // code against the same client that minted it.
  const state = signOauthState({ tenant_id: FGA_TENANT_ID, purpose, client: clientKind });
  const scopes = 'https://www.googleapis.com/auth/gmail.readonly';
  return 'https://accounts.google.com/o/oauth2/v2/auth'
    + `?client_id=${clientId}`
    + `&redirect_uri=${encodeURIComponent(gmailRedirectUri())}`
    + `&response_type=code&scope=${encodeURIComponent(scopes)}`
    + `&state=${state}&access_type=offline&prompt=consent`;
}

/**
 * Exchange the OAuth code and store the Gmail connection.
 *
 * Multi-mailbox (2026-07-08): rows are keyed on (tenant, provider, address), so
 * re-authorizing an existing address refreshes its tokens while a NEW address
 * adds a second inbox. The first mailbox connected for a provider becomes the
 * primary — that is the one the drip reply-sync polls; additional mailboxes are
 * invoice-scan-only.
 */
async function completeGmailConnect(db, code, { purpose = 'drip', client = 'internal' } = {}) {
  const { clientId, clientSecret } = oauthCreds(client);
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: gmailRedirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  const tokenData = await tokenRes.json();
  if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

  const profileRes = await fetch(`${GMAIL_API}/users/me/profile`, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const profile = await profileRes.json();
  const address = (profile.emailAddress || '').trim().toLowerCase() || null;
  if (!address) throw new Error('Google did not return an email address for this account');

  // Is this a re-auth of a known address, and does a primary already exist?
  const { data: existingRows } = await db
    .from('email_connections')
    .select('id, email_address, is_primary, scan_invoices')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('provider', 'gmail');
  const existing = (existingRows || []).find((r) => (r.email_address || '').toLowerCase() === address);
  const hasPrimary = (existingRows || []).some((r) => r.is_primary);

  const payload = {
    tenant_id: FGA_TENANT_ID,
    provider: 'gmail',
    email_address: address,
    // Bound for life: this token can only ever be refreshed by this client.
    oauth_client: client,
    access_token: tokenData.access_token,
    // Google omits refresh_token on re-consent in some flows — never clobber a
    // good stored one with undefined, or the mailbox silently stops refreshing.
    ...(tokenData.refresh_token ? { refresh_token: tokenData.refresh_token } : {}),
    expires_at: new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (!existing) {
    payload.is_primary = !hasPrimary;      // first inbox ever -> primary (drip)
    payload.scan_invoices = true;          // every connected inbox scans by default
  }

  const { data, error } = await db
    .from('email_connections')
    .upsert(payload, { onConflict: 'tenant_id,provider,email_address' })
    .select()
    .single();
  if (error) throw new Error(`Failed to store Gmail connection: ${error.message}`);

  log.success(`Gmail connected: ${address}${data.is_primary ? ' (primary)' : ''} [${purpose}, ${client} client]`);
  return data;
}

// ---------------------------------------------------------------------------
// Connection + token
// ---------------------------------------------------------------------------

/**
 * The PRIMARY Gmail inbox — what the drip reply-sync polls.
 *
 * Deliberately NOT .maybeSingle(): once a second mailbox is connected for
 * invoice scanning, maybeSingle() throws on multiple rows and would take the
 * outreach reply handling down with it. Order + limit(1) is the safe read.
 */
async function getGmailConnection(db) {
  const { data } = await db
    .from('email_connections')
    .select('*')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('provider', 'gmail')
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(1);
  return (data && data[0]) || null;
}

/** Every connected Gmail inbox. `onlyInvoiceScanning` filters to scan_invoices. */
async function getGmailConnections(db, { onlyInvoiceScanning = false } = {}) {
  let q = db
    .from('email_connections')
    .select('*')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('provider', 'gmail')
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true });
  if (onlyInvoiceScanning) q = q.eq('scan_invoices', true);
  const { data } = await q;
  return data || [];
}

async function ensureValidToken(db, conn) {
  const expiresAt = conn.expires_at ? new Date(conn.expires_at) : null;
  if (expiresAt && expiresAt > new Date(Date.now() + 5 * 60 * 1000)) return conn;
  if (!conn.refresh_token) return conn;

  // Refresh with the client that MINTED this token. Google rejects a refresh
  // presented with a different client's secret, so reading the ambient
  // GOOGLE_CLIENT_ID here would break every externally-connected mailbox.
  const { clientId, clientSecret } = oauthCreds(conn.oauth_client || 'internal');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: conn.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Gmail token refresh failed: ${data.error_description || data.error}`);

  const newExpiry = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
  await db.from('email_connections')
    .update({ access_token: data.access_token, expires_at: newExpiry, updated_at: new Date().toISOString() })
    .eq('id', conn.id);
  return { ...conn, access_token: data.access_token, expires_at: newExpiry };
}

// ---------------------------------------------------------------------------
// Gmail fetch helpers
// ---------------------------------------------------------------------------

async function gmailGet(path, token) {
  const res = await fetch(`${GMAIL_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.error) throw new Error(`Gmail API ${path}: ${data.error.message}`);
  return data;
}

async function listRecentMessages(token, { newerThanDays = 3, max = 50 } = {}) {
  const q = encodeURIComponent(`in:inbox newer_than:${newerThanDays}d`);
  const data = await gmailGet(`/users/me/messages?q=${q}&maxResults=${max}`, token);
  return data.messages || [];
}

const META_HEADERS = [
  'From', 'To', 'Subject', 'Date', 'Auto-Submitted', 'Precedence',
  'X-Autoreply', 'X-Autorespond', 'In-Reply-To', 'References', 'Return-Path',
];

async function getMessageMeta(token, id) {
  const qs = META_HEADERS.map((h) => `metadataHeaders=${h}`).join('&');
  const data = await gmailGet(`/users/me/messages/${id}?format=metadata&${qs}`, token);
  const headers = {};
  for (const h of data.payload?.headers || []) headers[h.name.toLowerCase()] = h.value;
  const fromRaw = headers.from || '';
  const m = fromRaw.match(/<([^>]+)>/);
  return {
    id: data.id,
    threadId: data.threadId,
    snippet: data.snippet || '',
    internalDate: data.internalDate ? new Date(Number(data.internalDate)).toISOString() : null,
    fromAddress: (m ? m[1] : fromRaw).trim().toLowerCase(),
    subject: headers.subject || '',
    headers,
  };
}

/** Full body text (for DSN bounce matching only). */
async function getMessageBodyText(token, id) {
  const data = await gmailGet(`/users/me/messages/${id}?format=full`, token);
  const chunks = [];
  const walk = (part) => {
    if (!part) return;
    if (part.body?.data) {
      try { chunks.push(Buffer.from(part.body.data, 'base64url').toString('utf8')); } catch (_) { /* skip */ }
    }
    for (const p of part.parts || []) walk(p);
  };
  walk(data.payload);
  return chunks.join('\n');
}

// ---------------------------------------------------------------------------
// Classification — deterministic first, AI for the ambiguous remainder
// ---------------------------------------------------------------------------

const OOO_RE = /\b(out of (the )?office|automatic reply|auto-?reply|autoreply|on vacation|on holiday|annual leave|parental leave|maternity|paternity|away from (my )?email|back (in the office )?on|currently (out|away|traveling))\b/i;
const BOUNCE_FROM_RE = /(mailer-daemon|postmaster|mail delivery (subsystem|system)|noreply.*bounce)/i;
const BOUNCE_SUBJ_RE = /\b(delivery status notification|undeliver|returned mail|mail delivery failed|failure notice|delivery (has )?failed|address not found)\b/i;
const UNSUB_RE = /\b(unsubscribe|remove me|take me off|stop (emailing|sending)|opt me out|do not (contact|email))\b/i;

/** Returns { classification, reason } or null when rules can't decide. */
function classifyDeterministic(msg) {
  const auto = (msg.headers['auto-submitted'] || '').toLowerCase();
  const precedence = (msg.headers.precedence || '').toLowerCase();

  if (BOUNCE_FROM_RE.test(msg.fromAddress) || BOUNCE_SUBJ_RE.test(msg.subject)) {
    return { classification: 'bounce', reason: 'DSN sender or delivery-failure subject' };
  }
  if (OOO_RE.test(msg.subject) || ((auto && auto !== 'no') && OOO_RE.test(msg.snippet))) {
    return { classification: 'out_of_office', reason: 'OOO pattern in subject/snippet' };
  }
  if ((auto && auto !== 'no') || msg.headers['x-autoreply'] || msg.headers['x-autorespond']
      || precedence === 'auto_reply') {
    return { classification: 'auto_reply', reason: `Auto-Submitted/Precedence header (${auto || precedence})` };
  }
  if (precedence === 'bulk' || precedence === 'junk') {
    return { classification: 'auto_reply', reason: `Precedence: ${precedence}` };
  }
  if (UNSUB_RE.test(`${msg.subject} ${msg.snippet}`)) {
    return { classification: 'unsubscribe_request', reason: 'Unsubscribe phrasing detected' };
  }
  return null;
}

/**
 * Claude fallback for messages the deterministic rules can't decide.
 * Returns { classification, confidence, reason, return_date }.
 */
async function classifyWithAI(msg) {
  const { askClaudeJSON } = require('../integrations/claude');
  const system = `You classify inbound emails received in reply to a B2B cold-outreach campaign.
Categories (choose exactly one):
- genuine_reply: a real human wrote back — interest, questions, objections, "no thanks", anything personally written
- out_of_office: vacation/away auto-responder (extract the return date if stated)
- auto_reply: any other automated response (ticket receipts, "we received your message", newsletters)
- unsubscribe_request: they ask to stop receiving emails
- ambiguous: cannot tell with reasonable confidence
Respond with JSON: {"classification":"<category>","confidence":<0.0-1.0>,"reason":"<one sentence>","return_date":"<YYYY-MM-DD or null>"}`;
  const user = `From: ${msg.fromAddress}\nSubject: ${msg.subject}\nBody preview: ${msg.snippet}`;
  try {
    const r = await askClaudeJSON(system, user, { maxTokens: 256 });
    return {
      classification: r.classification || 'ambiguous',
      confidence: Math.min(1, Math.max(0, Number(r.confidence) || 0.5)),
      reason: r.reason || '',
      return_date: r.return_date && /^\d{4}-\d{2}-\d{2}$/.test(r.return_date) ? r.return_date : null,
    };
  } catch (err) {
    log.warn(`AI classification failed (${msg.id}): ${err.message} — marking ambiguous`);
    return { classification: 'ambiguous', confidence: 0, reason: `AI classification failed: ${err.message}`, return_date: null };
  }
}

// ---------------------------------------------------------------------------
// Routing actions
// ---------------------------------------------------------------------------

async function addAttention(db, { type, severity, title, summary, leadId, payload = {} }) {
  try {
    await db.from('attention_queue').insert({
      tenant_id: FGA_TENANT_ID,
      type,
      severity,
      title,
      summary,
      entity_type: 'lead',
      entity_id: leadId,
      payload,
      produced_by: 'drip-campaign',
    });
  } catch (err) {
    log.warn(`attention_queue insert failed: ${err.message}`);
  }
}

async function recordInboundConversation(db, { leadId, msg, classification }) {
  try {
    await db.from('conversations').insert({
      tenant_id: FGA_TENANT_ID,
      lead_id: leadId,
      channel: 'email',
      direction: 'inbound',
      message_subject: msg.subject,
      message_body: msg.snippet,
      ai_classification: classification,
      external_id: msg.id,
      metadata: { gmail_message_id: msg.id, gmail_thread_id: msg.threadId, source: 'drip_gmail_sync' },
    });
  } catch (err) {
    log.warn(`conversations insert failed: ${err.message}`);
  }
}

async function routeClassified(db, enrollment, msg, cls) {
  const leadId = enrollment.lead_id;
  let action = 'ignored';

  switch (cls.classification) {
    case 'genuine_reply': {
      await stopEnrollment(db, enrollment.id, { status: 'replied', reason: 'genuine_reply', by: 'gmail-listener' });
      await db.from('leads').update({ status: 'replied', automation_status: 'replied_stop' }).eq('id', leadId).eq('tenant_id', FGA_TENANT_ID);
      await recordInboundConversation(db, { leadId, msg, classification: 'genuine_reply' });
      await addAttention(db, {
        type: 'drip_reply', severity: 'blue',
        title: 'Prospect replied to drip campaign',
        summary: `"${msg.subject}" from ${msg.fromAddress} — campaign stopped, lead moved to Replied.`,
        leadId, payload: { gmail_message_id: msg.id, snippet: msg.snippet },
      });
      // Sales-department handoff (2026-07-21): a real reply belongs to the
      // human now. Sets the lead's next action to the owner lane + pushes to
      // his phone. attentionType null — the drip_reply item above already
      // exists; this must not double-post. Best-effort by design.
      if (leadId) {
        try {
          const { markHumanHandoff } = require('./sales/coordination');
          await markHumanHandoff(db, FGA_TENANT_ID, leadId, {
            reason: 'drip_reply',
            action: 'review_reply',
            attentionType: null,
            summary: `"${msg.subject}" from ${msg.fromAddress}: ${String(msg.snippet || '').slice(0, 160)}`,
            producedBy: 'drip-campaign',
          });
        } catch (handoffErr) {
          log.warn(`Drip-reply handoff surfacing failed (non-fatal): ${handoffErr.message}`);
        }
      }
      action = 'stopped_campaign';
      break;
    }
    case 'out_of_office': {
      const until = cls.return_date
        ? new Date(`${cls.return_date}T12:00:00Z`)
        : new Date(Date.now() + 7 * 86400000);
      await pauseEnrollment(db, enrollment.id, { reason: 'out_of_office', until: until.toISOString(), by: 'gmail-listener' });
      action = 'paused_ooo';
      break;
    }
    case 'bounce': {
      const email = enrollment.metadata?.email;
      if (email) await suppress(db, { email, reason: 'bounce', source: 'gmail_dsn', leadId });
      await stopEnrollment(db, enrollment.id, { status: 'bounced', reason: 'delivery_failure', by: 'gmail-listener' });
      await addAttention(db, {
        type: 'drip_bounce', severity: 'amber',
        title: 'Drip email bounced',
        summary: `Delivery to ${email || 'prospect'} failed — campaign stopped, address suppressed.`,
        leadId, payload: { gmail_message_id: msg.id },
      });
      action = 'bounced_stop';
      break;
    }
    case 'unsubscribe_request': {
      const email = enrollment.metadata?.email || msg.fromAddress;
      await suppress(db, { email, reason: 'reply_request', source: 'gmail_reply', leadId });
      await stopEnrollment(db, enrollment.id, { status: 'unsubscribed', reason: 'reply_unsubscribe_request', by: 'gmail-listener' });
      await recordInboundConversation(db, { leadId, msg, classification: 'unsubscribe_request' });
      action = 'suppressed';
      break;
    }
    case 'auto_reply':
      action = 'ignored';
      break;
    default: { // ambiguous — pause for human review
      await db.from('drip_enrollments')
        .update({ status: 'review', paused_reason: 'ambiguous_inbound', updated_at: new Date().toISOString() })
        .eq('id', enrollment.id)
        .eq('status', 'active');
      await addAttention(db, {
        type: 'drip_review', severity: 'amber',
        title: 'Drip inbound needs review',
        summary: `Could not classify "${msg.subject}" from ${msg.fromAddress}. Campaign paused until you decide.`,
        leadId, payload: { gmail_message_id: msg.id, snippet: msg.snippet },
      });
      action = 'queued_for_review';
    }
  }
  return action;
}

// ---------------------------------------------------------------------------
// Main sync
// ---------------------------------------------------------------------------

async function syncDripReplies(db) {
  let conn = await getGmailConnection(db);
  if (!conn) return { skipped: 'no_gmail_connection' };
  conn = await ensureValidToken(db, conn);
  const token = conn.access_token;

  // Enrollments we care about — including stopped ones from the last 7 days
  // so late replies/bounces to a just-finished campaign still route.
  const { data: enrollments } = await db
    .from('drip_enrollments')
    .select('*')
    .eq('tenant_id', FGA_TENANT_ID)
    .or(`status.in.(active,paused,review),updated_at.gte.${new Date(Date.now() - 7 * 86400000).toISOString()}`);
  const byEmail = new Map();
  for (const e of enrollments || []) {
    const em = (e.metadata?.email || '').toLowerCase();
    if (em) byEmail.set(em, e);
  }
  if (byEmail.size === 0) return { processed: 0, matched: 0 };

  const messages = await listRecentMessages(token, { newerThanDays: 3, max: 50 });
  let processed = 0; let matched = 0;
  const results = [];

  for (const m of messages) {
    // already handled?
    const { data: seen } = await db
      .from('drip_inbound')
      .select('id')
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('gmail_message_id', m.id)
      .maybeSingle();
    if (seen) continue;

    let msg;
    try {
      msg = await getMessageMeta(token, m.id);
    } catch (err) {
      log.warn(`Message meta fetch failed (${m.id}): ${err.message}`);
      continue;
    }
    processed++;

    // match: sender address first; bounces matched by DSN body search
    let enrollment = byEmail.get(msg.fromAddress) || null;
    let deterministic = classifyDeterministic(msg);
    if (!enrollment && deterministic?.classification === 'bounce') {
      try {
        const body = (await getMessageBodyText(token, m.id)).toLowerCase();
        for (const [em, e] of byEmail) {
          if (body.includes(em)) { enrollment = e; break; }
        }
      } catch (_) { /* full fetch failed; leave unmatched */ }
    }
    if (!enrollment) continue; // not campaign-related — leave Patrick's inbox alone

    matched++;
    let cls;
    if (deterministic) {
      cls = { ...deterministic, confidence: 1, return_date: null, classified_by: 'deterministic' };
      if (deterministic.classification === 'out_of_office') {
        // let the AI try to pull the return date even when rules matched
        const ai = await classifyWithAI(msg);
        if (ai.return_date) cls.return_date = ai.return_date;
      }
    } else {
      const ai = await classifyWithAI(msg);
      cls = { ...ai, classified_by: 'ai' };
      // low-confidence genuine replies go to review, not auto-stop
      if (cls.classification === 'genuine_reply' && cls.confidence < 0.7) {
        cls.classification = 'ambiguous';
        cls.reason = `Low-confidence genuine_reply (${cls.confidence}): ${cls.reason}`;
      }
    }

    const action = await routeClassified(db, enrollment, msg, cls);

    await db.from('drip_inbound').insert({
      tenant_id: FGA_TENANT_ID,
      lead_id: enrollment.lead_id,
      enrollment_id: enrollment.id,
      gmail_message_id: msg.id,
      gmail_thread_id: msg.threadId,
      from_address: msg.fromAddress,
      subject: msg.subject,
      snippet: msg.snippet,
      received_at: msg.internalDate,
      classification: cls.classification,
      confidence: cls.confidence,
      classification_reason: cls.reason,
      classified_by: cls.classified_by,
      action_taken: action,
    });

    await db.from('drip_enrollments')
      .update({ gmail_thread_id: msg.threadId, last_inbound_at: msg.internalDate || new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', enrollment.id);

    results.push({ from: msg.fromAddress, classification: cls.classification, action });
  }

  return { processed, matched, results };
}

module.exports = {
  getGmailConnection,
  getGmailConnections,
  ensureValidToken,
  gmailGet,
  syncDripReplies,
  classifyDeterministic,
  buildGmailConnectUrl,
  completeGmailConnect,
  verifyOauthState,
  oauthCreds,
  configuredOauthClients,
  GMAIL_API,
};
