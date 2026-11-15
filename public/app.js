import { api, sessionPath } from './api.js';
import { createVoice } from './voice.js';
import {
  icon, escapeHtml, practiceView, suggestion, newView, sessionView, transcriptView,
  memoryView, memoryDialog, historyView, reviewView, settingsView,
} from './views.js';

const main = document.querySelector('#main');
const audio = document.querySelector('#agent-audio');
const notice = document.querySelector('#notice');
const pageLabel = document.querySelector('#page-label');
const connection = document.querySelector('#connection');

const state = {
  route: { page: 'practice', id: '' },
  status: null,
  dashboardError: '',
  sessions: [],
  memories: [],
  session: null,
  utterances: [],
  liveEvents: [],
  prompt: '',
  pendingText: '',
  voice: null,
  voiceState: 'idle',
  muted: false,
  busy: false,
  reviewFailed: false,
  routeGeneration: 0,
};
const pageNames = {
  practice: 'Practice', new: 'New session', bootstrap: 'Setup interview',
  memory: 'Memory', history: 'History', settings: 'Settings', session: 'Conversation', review: 'Review',
};

for (const element of document.querySelectorAll('[data-icon]')) {
  element.innerHTML = icon(element.dataset.icon);
}

function toast(message, error = false) {
  clearTimeout(toast.timer);
  notice.textContent = message;
  notice.classList.toggle('notice-error', error);
  notice.hidden = false;
  toast.timer = setTimeout(() => { notice.hidden = true; }, error ? 8500 : 3800);
}

function parseRoute() {
  const [page, id = ''] = location.hash.slice(1).split('/');
  return { page: Object.hasOwn(pageNames, page) ? page : 'practice', id };
}

function navigate(target) {
  if (location.hash === `#${target}`) void route();
  else location.hash = target;
}

function currentUtterances() {
  const ordered = [...state.liveEvents].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const rows = [];
  for (const fragment of ordered) {
    const previous = rows.at(-1);
    if (previous?.role === fragment.role && fragment.startMs - previous.endMs < 1600) {
      previous.text += fragment.text;
      previous.endMs = Math.max(previous.endMs, fragment.endMs);
    } else {
      rows.push({ ...fragment });
    }
  }
  return [...state.utterances, ...rows];
}

function scrollTranscript(force = false) {
  const element = document.querySelector('#transcript');
  if (!element) return;
  if (force || element.scrollHeight - element.scrollTop - element.clientHeight < 95) element.scrollTop = element.scrollHeight;
}

let captionFrame;
function updateTranscript() {
  if (captionFrame) return;
  captionFrame = requestAnimationFrame(() => {
    captionFrame = 0;
    const container = document.querySelector('#transcript');
    if (!container) return;
    const nearEnd = container.scrollHeight - container.scrollTop - container.clientHeight < 95;
    container.innerHTML = transcriptView(currentUtterances(), state.voiceState === 'idle' ? state.prompt : '');
    if (nearEnd) scrollTranscript(true);
  });
}

function render() {
  const { page, id } = state.route;
  pageLabel.textContent = pageNames[page];
  const navPage = ['new', 'bootstrap', 'session'].includes(page) ? 'practice' : page === 'review' ? 'history' : page;
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === navPage) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  connection.classList.toggle('ready', !!state.status?.voiceAvailable);
  connection.querySelector('span').textContent = state.status?.voiceAvailable ? 'Voice configured' : state.status ? 'Text preview' : 'Connection unavailable';
  main.setAttribute('aria-busy', 'false');
  if (state.dashboardError && !state.status) {
    main.innerHTML = `<div class="screen narrow-screen"><div class="error-banner">${escapeHtml(state.dashboardError)}</div><button class="button primary dark" data-action="reload">Retry connection</button></div>`;
    return;
  }
  if (!state.status) return;

  if (page === 'practice') {
    main.innerHTML = practiceView({
      needsBootstrap: state.status.needsBootstrap,
      active: state.sessions.find((session) => session.status === 'active'),
      memories: state.memories,
      sessions: state.sessions,
    });
  } else if (page === 'bootstrap' || page === 'new') {
    const params = new URLSearchParams(id);
    main.innerHTML = newView({
      mode: page === 'bootstrap' ? 'bootstrap' : 'conversation',
      topic: params.get('topic') ?? '',
      style: params.get('style') === 'debate' ? 'debate' : 'explore',
    });
  } else if (page === 'memory') {
    main.innerHTML = memoryView(state.memories);
  } else if (page === 'history') {
    main.innerHTML = historyView(state.sessions);
  } else if (page === 'settings') {
    main.innerHTML = settingsView(state.status);
  } else if (state.session?.id === id) {
    if (page === 'review') {
      main.innerHTML = reviewView(state.session, state.utterances);
    } else {
      main.innerHTML = sessionView({
        session: state.session,
        utterances: currentUtterances(),
        voiceState: state.voiceState,
        voiceAvailable: state.status.voiceAvailable,
        muted: state.muted,
        busy: state.busy,
        pendingText: state.pendingText,
        prompt: state.voiceState === 'idle' ? state.prompt : '',
        reviewFailed: state.reviewFailed,
      });
      scrollTranscript(true);
    }
  } else {
    main.innerHTML = '<div class="loading">Opening session…</div>';
    main.setAttribute('aria-busy', 'true');
  }
}

async function refreshDashboard() {
  const [status, { sessions }, { memories }] = await Promise.all([
    api('/api/status'), api('/api/sessions'), api('/api/memories'),
  ]);
  Object.assign(state, { status, sessions, memories, dashboardError: '' });
}

async function refreshSession(id) {
  const { session, utterances, opening } = await api(sessionPath(id));
  if (state.session?.id !== id && state.route.id !== id) return;
  Object.assign(state, { session, utterances, liveEvents: [], prompt: opening ?? '' });
}

async function disconnectVoice() {
  if (!state.voice) return;
  const voice = state.voice;
  const id = state.session.id;
  await voice.stop();
  if (state.voice !== voice) return;
  state.voice = null;
  state.voiceState = 'idle';
  state.muted = false;
  await refreshSession(id);
}

async function route() {
  const generation = ++state.routeGeneration;
  const target = parseRoute();
  const oldSessionId = state.session?.id;
  try {
    if (state.voice && (target.page !== 'session' || target.id !== oldSessionId)) {
      await disconnectVoice();
    }
    if (generation !== state.routeGeneration) return;
    state.route = target;
    if (['session', 'review'].includes(target.page) && target.id) {
      if (oldSessionId !== target.id) {
        Object.assign(state, { session: null, utterances: [], liveEvents: [], prompt: '', pendingText: '', reviewFailed: false });
      }
      render();
      await refreshSession(target.id);
      if (generation !== state.routeGeneration) return;
      const active = state.session.status === 'active';
      if (active !== (target.page === 'session')) {
        navigate(`${active ? 'session' : 'review'}/${target.id}`);
        return;
      }
    } else if (['practice', 'memory', 'history', 'settings'].includes(target.page)) {
      await refreshDashboard();
    } else if (['session', 'review'].includes(target.page)) {
      navigate('practice');
      return;
    }
    if (generation !== state.routeGeneration) return;
    render();
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (error) {
    if (generation !== state.routeGeneration) return;
    if (state.voice) {
      toast(`Your transcript still needs to be saved. ${error.message}`, true);
      if (!location.hash.startsWith('#session/')) navigate(`session/${oldSessionId}`);
      render();
      return;
    }
    state.dashboardError = error.message;
    if (!state.status) render();
    else main.innerHTML = `<div class="screen narrow-screen"><div class="error-banner">${escapeHtml(error.message)}</div><a href="#practice" class="button outline">Back to practice</a></div>`;
  }
}

async function busy(action) {
  if (state.busy) return;
  state.busy = true;
  if (state.route.page === 'session') render();
  try {
    await action();
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.busy = false;
    if (state.route.page === 'session') render();
  }
}

async function endSession({ withoutReview = false } = {}) {
  const id = state.session.id;
  await disconnectVoice();
  try {
    const result = await api(sessionPath(id, '/end'), { method: 'POST', body: withoutReview ? { withoutReview: true } : {} });
    if (state.session?.id === id) state.session = { ...result.session, review: result.review ?? result.session.review };
    if (state.route.id === id) navigate(`review/${id}`);
  } catch (error) {
    state.reviewFailed = true;
    throw error;
  }
}

async function connectVoice() {
  if (state.voiceState !== 'idle' || !state.status.voiceAvailable) return;
  const id = state.session.id;
  let voice;
  state.voiceState = 'connecting';
  state.muted = false;
  render();
  try {
    if (state.voice) {
      await disconnectVoice();
      if (state.route.id !== id) return;
      state.voiceState = 'connecting';
      render();
    }
    voice = createVoice({
      sessionId: id,
      audio,
      onTranscript(event) {
        if (state.voice !== voice) return;
        state.liveEvents.push(event);
        updateTranscript();
      },
      onLevel(level) {
        if (state.voice !== voice || state.route.id !== id || state.muted) return;
        const meter = document.querySelector('#mic-level');
        if (meter) meter.value = level;
        main.querySelector('.voice-orb')?.style.setProperty('--mic-level', level);
      },
      onState(status) {
        if (state.voice !== voice) return;
        state.voiceState = status;
        if (status === 'idle') state.muted = false;
        if (state.route.page === 'session' && state.route.id === id) render();
      },
      onError(message) { toast(message, true); },
    });
    state.voice = voice;
    await voice.connect();
  } catch (error) {
    if (state.voice === voice || (!voice && state.route.id === id)) {
      if (voice) state.voice = null;
      state.voiceState = 'idle';
      state.muted = false;
    }
    render();
    if (state.route.page === 'session' && state.route.id === id && error.name !== 'AbortError') toast(error.message, true);
  }
}

main.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) {
    if (event.target.closest('.voice-panel') && audio.srcObject && audio.paused) void audio.play().catch(() => {});
    return;
  }
  const { action, id, index } = button.dataset;
  switch (action) {
    case 'reload': void route(); break;
    case 'bootstrap': navigate('bootstrap'); break;
    case 'new': navigate('new'); break;
    case 'suggestion': {
      const topic = suggestion(Number(index));
      if (topic) navigate(`new/${new URLSearchParams({ topic: topic.title, style: topic.style })}`);
      break;
    }
    case 'resume': navigate(`session/${id}`); break;
    case 'connect': void connectVoice(); break;
    case 'disconnect': void busy(disconnectVoice); break;
    case 'mute':
      state.muted = !state.muted;
      state.voice?.setMuted(state.muted);
      render();
      main.querySelector('[data-action="mute"]')?.focus();
      break;
    case 'end': void busy(() => endSession()); break;
    case 'end-without-review': void busy(() => endSession({ withoutReview: true })); break;
    case 'edit-memory':
    case 'delete-memory': {
      const entry = state.memories.find((memory) => memory.id === id);
      if (!entry) break;
      const dialog = main.querySelector('#memory-dialog');
      dialog.innerHTML = memoryDialog(entry, action === 'delete-memory');
      dialog.showModal();
      break;
    }
    case 'cancel-dialog': main.querySelector('#memory-dialog').close(); break;
    default: break;
  }
});

main.addEventListener('input', (event) => {
  if (event.target.id === 'reply') state.pendingText = event.target.value;
});

main.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  if (form.getAttribute('id') === 'session-form') {
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    void busy(async () => {
      try {
        const { session, opening } = await api('/api/sessions', { method: 'POST', body: {
          mode: data.get('mode'),
          topic: String(data.get('topic') ?? '').trim(),
          language: data.get('language') ?? 'en',
          style: data.get('style') ?? 'explore',
        } });
        Object.assign(state, { session, prompt: opening ?? '', utterances: [], liveEvents: [], pendingText: '', reviewFailed: false });
        navigate(`session/${session.id}`);
      } finally {
        submit.disabled = false;
      }
    });
  } else if (form.getAttribute('id') === 'turn-form') {
    const text = String(data.get('reply') ?? '').trim();
    if (!text || state.voiceState !== 'idle') return;
    void busy(async () => {
      await disconnectVoice();
      const id = state.session.id;
      await api(sessionPath(id, '/turns'), { method: 'POST', body: { text } });
      state.pendingText = '';
      await refreshSession(id);
    }).then(() => document.querySelector('#reply')?.focus());
  } else if (form.getAttribute('id') === 'memory-form') {
    const id = data.get('id');
    const entry = state.memories.find((memory) => memory.id === id);
    if (!entry) return;
    const remove = data.get('op') === 'delete';
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    void busy(async () => {
      try {
        await api(`/api/memories/${encodeURIComponent(id)}`, remove ? { method: 'DELETE' } : {
          method: 'PATCH',
          body: { value: String(data.get('value') ?? '').trim(), version: entry.version },
        });
        await refreshDashboard();
        render();
        toast(remove ? 'Memory removed.' : 'Memory updated.');
      } finally {
        submit.disabled = false;
      }
    });
  }
});

window.addEventListener('hashchange', () => { if (state.status) void route(); });
window.addEventListener('pagehide', () => {
  if (state.voice) void state.voice.stop(false).catch(() => {});
});

void (async () => {
  try {
    await refreshDashboard();
    await route();
  } catch (error) {
    state.dashboardError = error.message;
    render();
  }
})();
