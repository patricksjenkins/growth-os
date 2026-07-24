/**
 * Day Activity — "what did the sales team actually do on <date>?"
 *
 * Built 2026-07-24. Answers the question the dashboard could not: not just
 * HOW MANY emails went out, but WHICH ones, to whom, and what they SAID.
 * Every item carries its full readable content so Patrick can click in and
 * read the actual email/reply/chat rather than trusting a counter.
 *
 * SCOPE: FGA internal ONLY (Command Center purpose directive). Every query
 * is explicitly .eq('tenant_id', FGA_TENANT_ID) — this is Patrick's own
 * sales activity. Client tenants' customer conversations never appear here;
 * their summary lives in the Information Center as counts.
 *
 * Sends are keyed off activity_log action='outreach_sent', which is the
 * canonical event for EVERY send path (autonomous dispatcher, manual
 * approve, bulk send) — verified against autosend_decisions and
 * outreach_sequences: all three agree.
 */

const express = require('express');
const router = express.Router();
const { getServiceClient } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const { FGA_TENANT_ID } = require('../../core/config');

const log = createLogger('admin-day-activity');
const ET = 'America/New_York';
const MAX_ITEMS = 200;

/** Strip HTML to readable text for the detail pane. */
function toText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#8217;/g, '’')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** ET day boundaries -> UTC ISO range. date = 'YYYY-MM-DD' or null (yesterday). */
function dayRange(dateStr) {
  const nowEtParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => nowEtParts.find((p) => p.type === t).value;
  let target = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
    ? dateStr
    : (() => {
        const d = new Date(`${get('year')}-${get('month')}-${get('day')}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0, 10);
      })();
  // ET is UTC-4 (EDT) / UTC-5 (EST); derive the offset for this date.
  const probe = new Date(`${target}T12:00:00Z`);
  const etHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: 'numeric', hour12: false }).format(probe));
  const offset = 12 - etHour; // 4 during EDT, 5 during EST
  const start = new Date(`${target}T00:00:00Z`);
  start.setUTCHours(start.getUTCHours() + offset);
  const end = new Date(start.getTime() + 86400000);
  return { date: target, startIso: start.toISOString(), endIso: end.toISOString() };
}

router.get('/', async (req, res) => {
  try {
    const db = getServiceClient();
    const { date, startIso, endIso } = dayRange(String(req.query.date || '').trim());
    const inDay = (q, col = 'created_at') => q.gte(col, startIso).lt(col, endIso);
    const T = (q) => q.eq('tenant_id', FGA_TENANT_ID);

    const [sentRes, dripRes, repliesRes, chatsRes, contentRes, leadsRes, callsRes, ownerRes] =
      await Promise.all([
        inDay(T(db.from('activity_log').select('id, entity_id, metadata, created_at')).eq('action', 'outreach_sent'))
          .order('created_at', { ascending: true }).limit(MAX_ITEMS),
        inDay(T(db.from('drip_sends').select('id, lead_id, day_offset, subject, body_html, sent_at, status')).eq('status', 'sent'), 'sent_at')
          .order('sent_at', { ascending: true }).limit(MAX_ITEMS),
        inDay(T(db.from('conversations').select('id, lead_id, channel, message_subject, message_body, ai_classification, created_at'))
          .eq('direction', 'inbound').eq('channel', 'email'))
          .order('created_at', { ascending: true }).limit(MAX_ITEMS),
        inDay(T(db.from('conversations').select('id, lead_id, message_body, metadata, created_at'))
          .eq('direction', 'inbound').eq('channel', 'web_chat'))
          .order('created_at', { ascending: true }).limit(MAX_ITEMS),
        inDay(T(db.from('content_drafts').select('id, headline, body, platform, status, created_at, posted_at')))
          .order('created_at', { ascending: true }).limit(MAX_ITEMS),
        inDay(T(db.from('leads').select('id, company_name, name, email, industry, hq_state, lead_source, lead_score, created_at')))
          .order('created_at', { ascending: true }).limit(MAX_ITEMS),
        inDay(T(db.from('voice_calls').select('id, caller_number, transcript, summary, duration_seconds, created_at')))
          .order('created_at', { ascending: true }).limit(MAX_ITEMS)
          .then((r) => r, () => ({ data: [] })),
        inDay(T(db.from('activity_log').select('id, entity_id, metadata, created_at')).eq('action', 'owner_reply_sent'))
          .order('created_at', { ascending: true }).limit(MAX_ITEMS),
      ]);

    // Hydrate lead names + the sent email bodies (sequences hold the copy).
    const leadIds = [...new Set([
      ...(sentRes.data || []).map((r) => r.entity_id),
      ...(dripRes.data || []).map((r) => r.lead_id),
      ...(repliesRes.data || []).map((r) => r.lead_id),
      ...(ownerRes.data || []).map((r) => r.entity_id),
    ].filter(Boolean))];
    const { data: leadRows } = leadIds.length
      ? await T(db.from('leads').select('id, company_name, name, email')).in('id', leadIds).limit(500)
      : { data: [] };
    const leadById = new Map((leadRows || []).map((l) => [l.id, l]));

    const seqIds = [...new Set((sentRes.data || []).map((r) => r.metadata?.sequence_id).filter(Boolean))];
    const { data: seqRows } = seqIds.length
      ? await T(db.from('outreach_sequences').select('id, message_subject, message_body')).in('id', seqIds).limit(500)
      : { data: [] };
    const seqById = new Map((seqRows || []).map((s) => [s.id, s]));

    const who = (id) => {
      const l = leadById.get(id);
      return l ? (l.company_name || l.name || l.email || 'Unknown') : 'Unknown';
    };

    const categories = [
      {
        key: 'outreach_sent',
        label: 'Cold outreach sent',
        icon: '📤',
        items: (sentRes.data || []).map((r) => {
          const seq = seqById.get(r.metadata?.sequence_id);
          return {
            id: r.id,
            at: r.metadata?.sent_at || r.created_at,
            title: who(r.entity_id),
            subtitle: r.metadata?.subject || seq?.message_subject || '(no subject)',
            recipient: r.metadata?.recipient || leadById.get(r.entity_id)?.email || null,
            body: toText(seq?.message_body || ''),
            badges: [r.metadata?.sent_via === 'auto_send' ? 'autonomous' : 'manual'].filter(Boolean),
            link: r.entity_id ? `/admin/pipeline/${r.entity_id}` : null,
          };
        }),
      },
      {
        key: 'drip_sent',
        label: 'Follow-ups sent',
        icon: '🔁',
        items: (dripRes.data || []).map((r) => ({
          id: r.id,
          at: r.sent_at,
          title: who(r.lead_id),
          subtitle: r.subject || '(no subject)',
          recipient: leadById.get(r.lead_id)?.email || null,
          body: toText(r.body_html),
          badges: [`day ${r.day_offset}`],
          link: r.lead_id ? `/admin/pipeline/${r.lead_id}` : null,
        })),
      },
      {
        key: 'replies',
        label: 'Replies received',
        icon: '↩️',
        items: (repliesRes.data || []).map((r) => ({
          id: r.id,
          at: r.created_at,
          title: who(r.lead_id),
          subtitle: r.message_subject || '(no subject)',
          recipient: null,
          body: toText(r.message_body),
          badges: [r.ai_classification].filter(Boolean),
          link: r.lead_id ? `/admin/pipeline/${r.lead_id}` : null,
        })),
      },
      {
        key: 'owner_replies',
        label: 'Your replies',
        icon: '✍️',
        items: (ownerRes.data || []).map((r) => ({
          id: r.id,
          at: r.created_at,
          title: who(r.entity_id),
          subtitle: r.metadata?.subject || '(no subject)',
          recipient: r.metadata?.recipient || null,
          body: '',
          badges: ['sent by you'],
          link: r.entity_id ? `/admin/pipeline/${r.entity_id}` : null,
        })),
      },
      {
        key: 'web_chats',
        label: 'Website chats',
        icon: '💬',
        items: (chatsRes.data || []).map((r) => ({
          id: r.id,
          at: r.created_at,
          title: r.metadata?.session_id ? `Visitor ${String(r.metadata.session_id).slice(0, 8)}` : 'Website visitor',
          subtitle: toText(r.message_body).slice(0, 90),
          recipient: null,
          body: toText(r.message_body),
          badges: [r.lead_id ? 'became a lead' : 'anonymous'],
          link: r.lead_id ? `/admin/pipeline/${r.lead_id}` : '/admin/web-chats',
        })),
      },
      {
        key: 'voice_calls',
        label: 'Calls answered',
        icon: '📞',
        items: (callsRes.data || []).map((r) => ({
          id: r.id,
          at: r.created_at,
          title: r.caller_number || 'Unknown caller',
          subtitle: (r.summary || '').slice(0, 90) || 'Call handled',
          recipient: null,
          body: toText(r.transcript || r.summary || ''),
          badges: r.duration_seconds ? [`${Math.round(r.duration_seconds)}s`] : [],
          link: '/admin/voice',
        })),
      },
      {
        key: 'content',
        label: 'Marketing content',
        icon: '📣',
        items: (contentRes.data || []).map((r) => ({
          id: r.id,
          at: r.posted_at || r.created_at,
          title: r.headline || '(untitled)',
          subtitle: `${r.platform || 'social'} · ${r.status}`,
          recipient: null,
          body: toText(r.body),
          badges: [r.status],
          link: '/admin/content',
        })),
      },
      {
        key: 'new_prospects',
        label: 'New prospects found',
        icon: '🔍',
        items: (leadsRes.data || []).map((r) => ({
          id: r.id,
          at: r.created_at,
          title: r.company_name || r.name || 'New prospect',
          subtitle: [r.industry, r.hq_state].filter(Boolean).join(' · ') || 'prospect',
          recipient: r.email || null,
          body: '',
          badges: [r.lead_score != null ? `score ${r.lead_score}` : 'unscored', r.lead_source].filter(Boolean),
          link: `/admin/pipeline/${r.id}`,
        })),
      },
    ].map((c) => ({ ...c, count: c.items.length }));

    res.json({
      success: true,
      date,
      range: { start: startIso, end: endIso },
      total: categories.reduce((s, c) => s + c.count, 0),
      categories,
    });
  } catch (err) {
    log.error(`day-activity failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
