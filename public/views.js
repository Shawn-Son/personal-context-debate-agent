export const icons = {
  practice: '<path d="M4 11v2m4-5v8m4-12v16m4-12v8m4-5v2"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  history: '<path d="M3 12a9 9 0 1 1 2.7 6.4M3 12V6m0 6h6m3-5v5l3 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.1h-4v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1A1.7 1.7 0 0 0 4.6 15 1.7 1.7 0 0 0 3.1 14H3v-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1L7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.5V3h4v.1A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  diagonal: '<path d="M7 17 17 7M7 7h10v10"/>',
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11v1a7 7 0 0 0 14 0v-1m-7 8v3"/>',
  micOff: '<path d="m3 3 18 18M9 9v3a3 3 0 0 0 5 2M9 5a3 3 0 0 1 6 1v4m-3 9v3m-7-11v1a7 7 0 0 0 12 5m2-5v-1"/>',
  spark: '<path d="M12 3c.7 5.5 3.5 8.3 9 9-5.5.7-8.3 3.5-9 9-.7-5.5-3.5-8.3-9-9 5.5-.7 8.3-3.5 9-9Z"/>',
  circle: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l1.5-4A8.5 8.5 0 1 1 21 11.5Z"/><path d="M9 11.5h6"/>',
  edit: '<path d="m14.5 5.5 4 4M4 20l4.5-1 12-12a2.8 2.8 0 0 0-4-4l-12 12L4 20Z"/>',
  trash: '<path d="M4 7h16m-9-3h2l2 3M6 7l1 13h10l1-13m-8 3v7m4-7v7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  back: '<path d="M19 12H5m6 6-6-6 6-6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  send: '<path d="m3 11 17-7-7 17-2-8-8-2Zm8 2 9-9"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};

export function icon(name, size = 20) {
  return `<svg aria-hidden="true" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${icons[name] ?? ''}</svg>`;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

const esc = escapeHtml;
export const kindNames = {
  profile: 'Background',
  preference: 'Preference',
  interest: 'Interest',
  viewpoint: 'Point of view',
  goal: 'Learning goal',
};

export function label(value) {
  return String(value ?? '').replace(/[._-]+/g, ' ').replace(/^./, (first) => first.toUpperCase());
}

export function memoryValue(value) {
  if (typeof value === 'string') {
    return /^(after_session|in_session|immediate|during_session)$/.test(value) ? label(value) : value;
  }
  if (value && typeof value === 'object') {
    return [value.position ?? value.value ?? value.text, value.reason].filter((part) => typeof part === 'string').join(' — ') || JSON.stringify(value);
  }
  return String(value ?? '');
}

export function dateLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(date);
}

export function topicTitle(session) {
  return session.topic?.trim() || (session.mode === 'bootstrap' ? 'Getting to know you' : 'Open conversation');
}

const suggestions = [
  { title: 'Does convenience make us less capable?', category: 'Technology', style: 'debate', icon: 'spark' },
  { title: 'What makes work worth doing?', category: 'Work & life', style: 'explore', icon: 'circle' },
  { title: 'Is curiosity something you can teach?', category: 'Learning', style: 'debate', icon: 'chat' },
];

function artwork() {
  return `<div class="hero-art" aria-hidden="true"><div class="wave">${Array.from({ length: 25 }, (_, index) => `<i class="wave-${index + 1}"></i>`).join('')}</div></div>`;
}

export function practiceView({ needsBootstrap, active, memories, sessions }) {
  const recent = sessions.find((session) => session.status !== 'active' && session.contextEligible && session.mode === 'conversation' && session.summary);
  const activeMemories = memories.filter((entry) => entry.status === 'active');
  const openQuestion = recent?.review?.openQuestion?.trim();
  const deskLabel = active ? 'Session in progress' : needsBootstrap ? 'Setup interview' : openQuestion ? 'Continue a topic' : 'Speaking session';
  const deskTitle = active ? topicTitle(active) : needsBootstrap ? 'Set up your practice.' : openQuestion || 'Your next conversation';
  const deskDescription = active
    ? 'Your place in this conversation is saved.'
    : needsBootstrap
      ? 'Tell your partner what you want to practice, which ideas interest you, and when to give feedback.'
      : openQuestion
        ? `From your last session · ${topicTitle(recent)}`
        : 'Bring a question to explore or test your argument against a different point of view.';
  const continueTopic = openQuestion
    ? `new/${new URLSearchParams({ topic: openQuestion.slice(0, 180), style: recent.style ?? 'explore' })}`
    : '';

  return `<div class="screen practice-screen">
    <header class="practice-heading">
      <div><h1>Practice</h1><p>Explore ideas and build confidence speaking English.</p></div>
      ${active || needsBootstrap ? `<button class="button outline practice-new" data-action="new">${icon('plus', 17)} New session</button>` : ''}
    </header>
    <section class="hero session-desk" aria-labelledby="desk-title">
      <div class="hero-copy">
        <p class="desk-meta">${icon(active ? 'history' : 'practice', 16)} ${deskLabel}</p>
        <h2 class="desk-title" id="desk-title">${esc(deskTitle)}</h2>
        <p class="hero-description">${esc(deskDescription)}</p>
        <div class="hero-actions">
          ${active ? `<button class="button primary" data-action="resume" data-id="${esc(active.id)}">${icon('mic', 18)} Resume session</button>`
          : needsBootstrap ? `<button class="button primary" data-action="bootstrap">${icon('mic', 18)} Start setup interview</button>`
          : continueTopic ? `<a class="button primary" href="#${esc(continueTopic)}">${icon('mic', 18)} Continue discussion</a><a class="button text-button" href="#review/${esc(recent.id)}">Read review ${icon('arrow', 17)}</a>`
          : `<button class="button primary" data-action="new">${icon('mic', 18)} Start a conversation</button>`}
        </div>
      </div>${artwork()}
    </section>
    <div class="practice-grid">
      <section class="prompts-section" aria-labelledby="topics-heading">
        <div class="section-heading"><h2 id="topics-heading">Discussion prompts</h2><button class="button text-button topic-create" data-action="new">${icon('plus', 16)} Custom topic</button></div>
        <div class="topic-list">
          ${suggestions.map((suggestion, index) => `<button class="topic-card" data-action="suggestion" data-index="${index}"><span class="topic-icon topic-icon-${index}">${icon(suggestion.icon, 18)}</span><span><strong>${esc(suggestion.title)}</strong><small>${suggestion.category} <b>·</b> ${label(suggestion.style)}</small></span><span class="topic-arrow">${icon('diagonal', 17)}</span></button>`).join('')}
        </div>
      </section>
      <section class="context-card" aria-labelledby="context-heading">
        <div class="context-top"><h2 id="context-heading">Your context</h2><a class="icon-link" href="#memory" aria-label="Open memory">${icon('diagonal', 17)}</a></div>
        ${activeMemories.length
          ? `<ul class="context-list">${activeMemories.slice(0, 3).map((entry) => `<li class="context-row"><small>${esc(kindNames[entry.kind] ?? label(entry.kind))}</small><span>${esc(memoryValue(entry.value))}</span></li>`).join('')}</ul>`
          : '<p class="context-empty">Goals, interests and feedback preferences will appear here as you practice.</p>'}
        <a class="under-link" href="#memory">Manage memory ${icon('arrow', 16)}</a>
      </section>
    </div>
  </div>`;
}

export function suggestion(index) {
  return suggestions[index];
}

export function newView({ mode, topic = '', style = 'explore' }) {
  const bootstrap = mode === 'bootstrap';
  return `<div class="screen narrow-screen">
    <a class="back-link" href="#practice">${icon('back', 17)} Practice</a>
    <div class="static-heading">
      <h1>${bootstrap ? 'Setup interview' : 'New session'}</h1>
      <p>${bootstrap ? 'Answer a few questions to personalize your practice. You can skip any question.' : 'Pick a topic and decide how you want to discuss it.'}</p>
    </div>
    <form id="session-form" class="panel form-panel">
      <input type="hidden" name="mode" value="${mode}">
      ${bootstrap ? `<div class="setup-outline"><p>${icon('circle', 19)} Your interests and what you like to talk about</p><p>${icon('spark', 19)} What you want to do better in English</p><p>${icon('chat', 19)} How and when you want feedback</p></div>`
      : `<label class="field">Topic <span class="muted-label">Optional</span><input name="topic" maxlength="180" value="${esc(topic)}" placeholder="e.g. Is remote work better for deep work?"></label>
      <fieldset><legend>Conversation style</legend><div class="radio-grid"><label class="option"><input type="radio" name="style" value="explore" ${style !== 'debate' ? 'checked' : ''}><span><strong>Explore</strong><small>Develop an idea through questions.</small></span></label><label class="option"><input type="radio" name="style" value="debate" ${style === 'debate' ? 'checked' : ''}><span><strong>Debate</strong><small>Test your position against a counterargument.</small></span></label></div></fieldset>`}
      ${bootstrap ? '<label class="field">Interview language<select name="language"><option value="en">English</option><option value="ko">한국어 · Korean</option></select></label>' : ''}
      <p class="small-note">Your transcript is saved in History. You can manage what carries forward in <a class="under-link" href="#memory">Memory</a>.</p>
      <button class="button primary dark" type="submit">${bootstrap ? 'Begin setup' : 'Open session'} ${icon('arrow', 18)}</button>
    </form>
  </div>`;
}

export function sessionView({ session, utterances, voiceState, voiceAvailable, busy, muted, pendingText, prompt, reviewFailed }) {
  const live = voiceState === 'connected';
  const connecting = voiceState === 'connecting';
  const bootstrap = session.mode === 'bootstrap';
  return `<div class="screen session-screen">
    <a class="back-link" href="#practice">${icon('back', 17)} Practice</a>
    <div class="session-heading"><div><p class="session-meta">${icon('practice', 16)} ${bootstrap ? 'Setup interview' : (session.style === 'debate' ? 'Debate' : 'Explore')}<span aria-hidden="true">·</span>${session.language === 'ko' ? 'Korean' : 'English'}</p><h1>${esc(topicTitle(session))}</h1></div>
      <div class="end-actions">${reviewFailed ? '<button class="button outline" data-action="end-without-review">Save transcript only</button>' : ''}
      <button class="button outline" data-action="end" ${busy || connecting ? 'disabled' : ''}>${busy ? 'Working…' : 'End & review'} ${icon('arrow', 17)}</button></div>
    </div>
    <div class="session-grid">
      <section class="voice-panel ${live ? 'is-live' : ''}" aria-label="Voice controls">
        <div class="voice-panel-header"><h2>Microphone</h2><p class="voice-status" role="status"><i></i>${live ? (muted ? 'Muted' : 'Connected') : connecting ? 'Connecting…' : voiceAvailable ? 'Disconnected' : 'Text preview'}</p></div>
        <div class="voice-orb" aria-hidden="true"><div class="orb-bars"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div>
        ${live ? '<div class="mic-meter"><label for="mic-level">Input level</label><meter id="mic-level" min="0" max="1" value="0"></meter></div>' : ''}
        <div class="voice-actions">
          ${live ? `<button class="button primary" data-action="mute">${icon(muted ? 'micOff' : 'mic', 18)} ${muted ? 'Unmute' : 'Mute mic'}</button><button class="button outline-on-dark" data-action="disconnect" ${busy ? 'disabled' : ''}>Disconnect</button>`
          : connecting ? '<button class="button outline-on-dark" data-action="disconnect">Cancel connection</button>'
          : `<button class="button primary" data-action="connect" ${!voiceAvailable || busy ? 'disabled' : ''}>${icon('mic', 18)} Connect microphone</button>`}
        </div>
        ${voiceAvailable ? '' : '<p class="voice-help">Use the transcript to practice by typing. Configure voice in <a href="#settings">Settings</a>.</p>'}
      </section>
      <section class="panel transcript-panel" aria-labelledby="transcript-heading">
        <div class="transcript-header"><h2 id="transcript-heading">Transcript</h2>${live ? '<span class="live-label">Live</span>' : ''}</div>
        <div class="transcript" id="transcript" role="log" aria-label="Conversation messages">${transcriptView(utterances, prompt)}</div>
        <form id="turn-form" class="composer">
          <label class="visually-hidden" for="reply">Your reply</label>
          <input id="reply" name="reply" maxlength="2400" autocomplete="off" placeholder="${live ? 'Disconnect voice to type' : 'Type your reply…'}" value="${esc(pendingText)}" ${live || connecting || busy ? 'disabled' : ''}>
          <button class="button send-button" aria-label="Send reply" ${live || connecting || busy ? 'disabled' : ''}>${icon('send', 19)}</button>
        </form>
      </section>
    </div>
  </div>`;
}

export function transcriptView(utterances, prompt) {
  if (!utterances.length && !prompt) return '<p class="empty-transcript">Your conversation will appear here.</p>';
  const rows = utterances.length ? utterances : [{ role: 'assistant', text: prompt }];
  return rows.filter((item) => item.text.trim()).map((item) => `<div class="message message-${item.role === 'user' ? 'user' : 'assistant'}"><span class="message-label">${item.role === 'user' ? 'You' : 'Partner'}</span><p>${esc(item.text)}</p></div>`).join('');
}

export function memoryView(memories) {
  return `<div class="screen content-screen">
    <div class="static-heading"><h1>Your memory</h1><p>Review and edit the context your partner uses in future sessions.</p></div>
    ${memories.length ? `<div class="memory-list">${memories.map((entry) => `<article class="panel memory-item">
      <div class="memory-text"><div class="memory-tags"><span class="pill">${esc(kindNames[entry.kind] ?? label(entry.kind))}</span>${entry.status && entry.status !== 'active' ? `<span class="pill pending">${esc(label(entry.status))}</span>` : ''}</div>
      <h2>${esc(memoryValue(entry.value))}</h2><p>${entry.scope && !['general', 'global', 'general_conversation'].includes(entry.scope) ? `${esc(label(entry.scope))} · ` : ''}${esc(label(String(entry.key ?? '').split('.').at(-1)))}</p>
      ${evidenceView(entry.evidence)}</div>
      <div class="memory-actions"><button class="button icon-button" aria-label="Edit memory" data-action="edit-memory" data-id="${esc(entry.id)}">${icon('edit', 18)}</button><button class="button icon-button danger" aria-label="Delete memory" data-action="delete-memory" data-id="${esc(entry.id)}">${icon('trash', 18)}</button></div>
    </article>`).join('')}</div>` : emptyState('layers', 'Nothing remembered yet', 'Complete the setup interview or a conversation to start building your personal context.', '<button class="button primary dark" data-action="bootstrap">Start setup interview</button>')}
    <dialog id="memory-dialog" aria-labelledby="memory-dialog-title"></dialog>
  </div>`;
}

function evidenceView(evidence) {
  if (!Array.isArray(evidence)) return '';
  const quotes = evidence.map((entry) => entry?.quote ?? entry?.text).filter(Boolean);
  if (!quotes.length) return '';
  return `<details class="evidence"><summary>Conversation evidence</summary>${quotes.map((quote) => `<blockquote>${esc(quote)}</blockquote>`).join('')}</details>`;
}

export function memoryDialog(entry, remove = false) {
  return `<form id="memory-form" class="form-panel">
    <input type="hidden" name="id" value="${esc(entry.id)}"><input type="hidden" name="op" value="${remove ? 'delete' : 'edit'}">
    <h2 id="memory-dialog-title">${remove ? 'Remove this memory?' : 'Edit memory'}</h2>
    ${remove ? `<p>This detail will be removed from the context used in future conversations.</p><blockquote>${esc(memoryValue(entry.value))}</blockquote>` : `<label class="field">What should your partner remember?<textarea name="value" rows="4" required maxlength="1200">${esc(typeof entry.value === 'string' ? entry.value : memoryValue(entry.value))}</textarea></label>`}
    <div class="form-actions"><button class="button outline" type="button" data-action="cancel-dialog">Cancel</button><button class="button ${remove ? 'destructive' : 'primary dark'}" type="submit">${remove ? 'Remove memory' : 'Save memory'}</button></div>
  </form>`;
}

function emptyState(symbol, title, description, action = '') {
  return `<div class="panel empty-state"><span>${icon(symbol, 26)}</span><h2>${title}</h2><p>${description}</p>${action}</div>`;
}

export function historyView(sessions) {
  return `<div class="screen content-screen">
    <div class="static-heading"><h1>Session history</h1><p>Resume a session or revisit its transcript and feedback.</p></div>
    ${sessions.length ? `<div class="history-list">${sessions.map((session) => `<a class="panel history-item" href="#${session.status === 'active' ? 'session' : 'review'}/${esc(session.id)}"><span class="topic-icon">${icon(session.mode === 'bootstrap' ? 'layers' : 'chat', 21)}</span><span><small>${esc(dateLabel(session.startedAt))} · ${session.mode === 'bootstrap' ? 'Setup interview' : 'Practice session'}</small><strong>${esc(topicTitle(session))}</strong>${session.summary ? `<p>${esc(session.summary)}</p>` : ''}</span><span class="history-end">${session.status === 'active' ? '<span class="pill">In progress</span>' : ''}${icon('arrow', 19)}</span></a>`).join('')}</div>` : emptyState('history', 'Your sessions will show up here', 'After you start, you can return to the transcript and feedback at any time.', '<a class="button primary dark" href="#practice">Go to practice</a>')}
  </div>`;
}

export function reviewView(session, utterances) {
  const review = session.review ?? {};
  const feedback = Array.isArray(review.feedback) ? review.feedback : [];
  const changes = Array.isArray(review.changes) ? review.changes : [];
  const unreviewed = !session.review;
  return `<div class="screen content-screen">
    <a class="back-link" href="#history">${icon('back', 17)} History</a>
    <div class="static-heading"><h1>${esc(topicTitle(session))}</h1><p>Session review · ${esc(dateLabel(session.endedAt ?? session.startedAt))}</p></div>
    ${unreviewed ? `<div class="panel prose-card"><h2>Review unavailable</h2><p>Your transcript is available below.</p></div>`
      : `<div class="panel prose-card"><h2>What we discussed</h2><p>${esc(review.summary ?? session.summary ?? 'No summary was recorded.')}</p>${review.openQuestion ? `<p class="review-question"><strong>Pick up here</strong> ${esc(review.openQuestion)}</p>` : ''}</div>
      <div class="review-grid"><section class="panel prose-card"><h2>English feedback</h2>${feedback.length ? feedback.map((item) => `<article class="review-note"><p class="original">${esc(item.original)}</p><p><strong>${esc(item.suggestion)}</strong></p><p>${esc(item.why)}</p></article>`).join('') : '<p>No expression feedback was saved for this session.</p>'}</section>
      <section class="panel prose-card"><h2>Memory updates</h2>${changes.length ? changes.map((item) => `<article class="review-note"><span class="pill">${esc(label(item.action))}</span><p>${esc(memoryValue(item.value))}</p></article>`).join('') : '<p>No long-term memories changed.</p>'}<a class="under-link" href="#memory">Manage memory ${icon('arrow', 17)}</a></section></div>`}
    <details class="panel transcript-details"><summary>Read the transcript</summary><div>${transcriptView(utterances)}</div></details>
  </div>`;
}

export function settingsView(status) {
  return `<div class="screen content-screen">
    <div class="static-heading"><h1>Settings</h1><p>Connections and conversation preferences.</p></div>
    <section class="panel prose-card settings-card">
      <h2>AI connection</h2>
      <div class="setting-row"><span><strong>Live voice</strong><small>Talk through your browser microphone.</small></span><span class="pill ${status.voiceAvailable ? 'ready' : 'pending'}">${status.voiceAvailable ? 'Configured' : 'Not configured'}</span></div>
      <div class="setting-row"><span><strong>Session review</strong><small>Summaries, memory updates, and English feedback.</small></span><span class="pill ${status.reviewAvailable ? 'ready' : 'pending'}">${status.reviewAvailable ? 'Configured' : 'Not configured'}</span></div>
      ${!status.voiceAvailable || !status.reviewAvailable ? '<p class="small-note">To enable AI features, set your OpenAI API key on the server and restart the app. The key stays on the server.</p>' : ''}
    </section>
    <section class="panel prose-card settings-card"><h2>Personal context</h2><p>Share only the details you want your partner to use. You can edit or remove saved items in Memory.</p><div class="form-actions"><button class="button outline" data-action="bootstrap">${icon('mic', 17)} Run setup interview</button><a href="#memory" class="under-link">View memory ${icon('arrow', 17)}</a></div></section>
  </div>`;
}
