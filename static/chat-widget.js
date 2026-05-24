/**
 * Growth OS — Embeddable Chat Widget
 *
 * Drop-in <script> tag for customer DFY websites. Renders a floating
 * chat bubble in the bottom-right corner that opens an inline chat
 * window powered by the tenant's AI Chat Agent.
 *
 * Usage:
 *   <script src="https://api.firstgenautomate.com/chat/widget.js"
 *           data-tenant="TENANT_UUID" defer></script>
 *
 * The widget:
 *   1. Creates an iframe-free inline chat UI (no cross-origin issues)
 *   2. Sends messages to POST /api/chat with the tenant_id
 *   3. Stores session_id in sessionStorage for conversation continuity
 *   4. Styles itself with CSS custom properties from the host page
 */
(function () {
  'use strict';

  var script = document.currentScript || document.querySelector('script[data-tenant]');
  if (!script) return;

  var tenantId = script.getAttribute('data-tenant');
  if (!tenantId) return;

  // V1 hardening (2026-05-24): the chat endpoint requires a signed
  // widget_token for any non-FGA tenant_id. The DFY website-build agent
  // mints this at site-build time and embeds it as data-widget-token.
  // Without it, the widget gets 403 invalid_widget_token from /api/chat.
  // FGA's own marketing-site widget renders without this attribute and
  // /api/chat falls back to the Origin allowlist for that one tenant.
  var widgetToken = script.getAttribute('data-widget-token') || null;

  var apiBase = script.src.replace(/\/chat\/widget\.js.*$/, '').replace(/\/static\/chat-widget\.js.*$/, '');
  var sessionKey = 'gos_chat_' + tenantId.slice(0, 8);
  var sessionId = sessionStorage.getItem(sessionKey) || ('chat_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now());
  sessionStorage.setItem(sessionKey, sessionId);

  var messages = [];
  var isOpen = false;
  var isLoading = false;

  // Get brand color from host page CSS vars or fallback
  var style = getComputedStyle(document.documentElement);
  var brandColor = style.getPropertyValue('--color-primary').trim() || '#132A4A';
  var accentColor = style.getPropertyValue('--color-accent').trim() || '#22C55E';

  // ── Create DOM ──────────────────────────────────────────────────

  var container = document.createElement('div');
  container.id = 'gos-chat-widget';
  container.innerHTML = [
    '<style>',
    '#gos-chat-widget { position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 99999; font-family: Inter, system-ui, -apple-system, sans-serif; }',
    '#gos-chat-bubble { width: 60px; height: 60px; border-radius: 50%; background: ' + brandColor + '; color: #fff; border: none; cursor: pointer; box-shadow: 0 4px 20px rgba(0,0,0,0.2); display: flex; align-items: center; justify-content: center; transition: transform 0.2s; font-size: 1.5rem; }',
    '#gos-chat-bubble:hover { transform: scale(1.1); }',
    '#gos-chat-window { display: none; width: 380px; max-width: calc(100vw - 2rem); height: 520px; max-height: calc(100vh - 8rem); background: #fff; border-radius: 1rem; box-shadow: 0 10px 40px rgba(0,0,0,0.15); overflow: hidden; flex-direction: column; margin-bottom: 0.75rem; }',
    '#gos-chat-window.open { display: flex; }',
    '#gos-chat-header { background: ' + brandColor + '; color: #fff; padding: 1rem 1.25rem; display: flex; align-items: center; justify-content: space-between; }',
    '#gos-chat-header h4 { margin: 0; font-size: 0.9375rem; font-weight: 600; }',
    '#gos-chat-header button { background: none; border: none; color: rgba(255,255,255,0.7); cursor: pointer; font-size: 1.25rem; padding: 0; line-height: 1; }',
    '#gos-chat-header button:hover { color: #fff; }',
    '#gos-chat-messages { flex: 1; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: 0.75rem; }',
    '.gos-msg { max-width: 85%; padding: 0.625rem 0.875rem; border-radius: 1rem; font-size: 0.875rem; line-height: 1.5; word-wrap: break-word; }',
    '.gos-msg-user { background: ' + brandColor + '; color: #fff; align-self: flex-end; border-bottom-right-radius: 0.25rem; }',
    '.gos-msg-bot { background: #f1f5f9; color: #1e293b; align-self: flex-start; border-bottom-left-radius: 0.25rem; }',
    '.gos-typing { align-self: flex-start; background: #f1f5f9; padding: 0.75rem 1rem; border-radius: 1rem; font-size: 0.8125rem; color: #94a3b8; }',
    '#gos-chat-input { display: flex; border-top: 1px solid #e2e8f0; padding: 0.75rem; gap: 0.5rem; }',
    '#gos-chat-input input { flex: 1; border: 1px solid #d1d5db; border-radius: 0.5rem; padding: 0.5rem 0.75rem; font-size: 0.875rem; font-family: inherit; outline: none; }',
    '#gos-chat-input input:focus { border-color: ' + brandColor + '; }',
    '#gos-chat-input button { background: ' + brandColor + '; color: #fff; border: none; border-radius: 0.5rem; padding: 0.5rem 1rem; font-size: 0.875rem; font-weight: 600; cursor: pointer; white-space: nowrap; }',
    '#gos-chat-input button:disabled { opacity: 0.5; cursor: not-allowed; }',
    '@media (max-width: 480px) { #gos-chat-window { width: calc(100vw - 2rem); height: calc(100vh - 6rem); border-radius: 0.75rem; } }',
    '</style>',
    '<div id="gos-chat-window">',
    '  <div id="gos-chat-header"><h4>Chat with us</h4><button id="gos-chat-close" aria-label="Close">&times;</button></div>',
    '  <div id="gos-chat-messages"></div>',
    '  <div id="gos-chat-input"><input type="text" placeholder="Type a message..." id="gos-chat-text" /><button id="gos-chat-send">Send</button></div>',
    '</div>',
    '<button id="gos-chat-bubble" aria-label="Chat">&#128172;</button>',
  ].join('\n');

  document.body.appendChild(container);

  var bubble = document.getElementById('gos-chat-bubble');
  var chatWindow = document.getElementById('gos-chat-window');
  var closeBtn = document.getElementById('gos-chat-close');
  var messagesEl = document.getElementById('gos-chat-messages');
  var inputEl = document.getElementById('gos-chat-text');
  var sendBtn = document.getElementById('gos-chat-send');

  bubble.addEventListener('click', function () {
    isOpen = !isOpen;
    chatWindow.classList.toggle('open', isOpen);
    bubble.style.display = isOpen ? 'none' : 'flex';
    if (isOpen && messages.length === 0) {
      addMessage('bot', 'Hi there! How can we help you today?');
    }
    if (isOpen) inputEl.focus();
  });

  closeBtn.addEventListener('click', function () {
    isOpen = false;
    chatWindow.classList.remove('open');
    bubble.style.display = 'flex';
  });

  function addMessage(role, text) {
    messages.push({ role: role === 'bot' ? 'assistant' : 'user', content: text });
    var div = document.createElement('div');
    div.className = 'gos-msg gos-msg-' + role;
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showTyping() {
    var div = document.createElement('div');
    div.className = 'gos-typing';
    div.id = 'gos-typing';
    div.textContent = 'Typing...';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideTyping() {
    var el = document.getElementById('gos-typing');
    if (el) el.remove();
  }

  async function sendMessage() {
    var text = inputEl.value.trim();
    if (!text || isLoading) return;

    addMessage('user', text);
    inputEl.value = '';
    isLoading = true;
    sendBtn.disabled = true;
    showTyping();

    try {
      var payload = {
        messages: messages.filter(function (m) { return m.role === 'user' || m.role === 'assistant'; }),
        session_id: sessionId,
        tenant_id: tenantId,
      };
      // V1 hardening (2026-05-24): include the HMAC widget_token so the
      // chat endpoint can verify the tenant_id wasn't spoofed. Omit for
      // the FGA marketing-site widget — chat.js treats that path via
      // the Origin header allowlist instead.
      if (widgetToken) payload.widget_token = widgetToken;
      var res = await fetch(apiBase + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var data = await res.json();
      hideTyping();
      if (data.reply) {
        addMessage('bot', data.reply);
      } else {
        addMessage('bot', 'Sorry, something went wrong. Please try again.');
      }
    } catch (err) {
      hideTyping();
      addMessage('bot', 'Connection error. Please try again in a moment.');
    }

    isLoading = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }

  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') sendMessage();
  });
})();
