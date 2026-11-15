import { api, sessionPath } from './api.js';
import { createMicrophoneMeter } from './meter.js';

function timeout(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForIce(peer) {
  if (peer.iceGatheringState === 'complete') return;
  let onState;
  try {
    await Promise.race([new Promise((resolve) => {
      onState = () => {
        if (peer.iceGatheringState === 'complete') resolve();
      };
      peer.addEventListener('icegatheringstatechange', onState);
      onState();
    }), timeout(10_000).then(() => { throw new Error('The voice network could not find a route. Try reconnecting.'); })]);
  } finally {
    peer.removeEventListener('icegatheringstatechange', onState);
  }
}

export function createVoice({ sessionId, audio, onTranscript, onState, onError, onLevel }) {
  const streamId = crypto.randomUUID();
  const peer = new RTCPeerConnection();
  const channel = peer.createDataChannel('oai-events');
  const connectionController = new AbortController();
  const pending = [];
  const seen = new Set();
  let media;
  let meter;
  let saving;
  let timer;
  let cleaned = false;
  let closing;
  let didStart = false;
  let resolveStarted;
  let rejectStarted;
  let resolveClosed;

  const started = new Promise((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  started.catch(() => {});
  const closed = new Promise((resolve) => { resolveClosed = resolve; });

  function send(type, data = {}) {
    if (channel.readyState !== 'open') return false;
    channel.send(JSON.stringify({ type, event_id: crypto.randomUUID(), ...data }));
    return true;
  }

  async function flush() {
    while (pending.length) {
      if (!saving) {
        const events = pending.slice(0, 100);
        saving = api(sessionPath(sessionId, '/transcript'), { method: 'POST', body: { events } })
          .then(() => pending.splice(0, events.length))
          .finally(() => { saving = undefined; });
      }
      await saving;
    }
  }

  function scheduleFlush() {
    if (timer || cleaned) return;
    timer = setTimeout(() => {
      timer = null;
      flush().catch(() => onError('The transcript could not be saved. It will retry when you disconnect or end the session.'));
    }, 900);
  }

  channel.addEventListener('message', ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.type === 'session.started') {
      didStart = true;
      resolveStarted();
      return;
    }
    if (message.type === 'session.closed') {
      resolveClosed();
      if (!closing) stop(false).catch((error) => onError(error.message));
      return;
    }
    if (message.type === 'error') {
      if (closing) return;
      if (!didStart) rejectStarted(new Error('The voice connection could not start.'));
      else onError('Voice encountered a provider error. You can reconnect or type your reply.');
      return;
    }
    const role = message.type === 'session.input_transcript.delta' ? 'user'
      : message.type === 'session.output_transcript.delta' ? 'assistant' : null;
    if (!role || typeof message.delta !== 'string' || !message.delta.length ||
      !Number.isFinite(message.start_ms) || !Number.isFinite(message.end_ms) ||
      message.start_ms < 0 || message.end_ms < message.start_ms) return;
    const providerId = message.event_id ?? crypto.randomUUID();
    if (seen.has(providerId)) return;
    seen.add(providerId);
    const entry = {
      eventId: `${streamId}:${providerId}`.slice(0, 120),
      streamId,
      role,
      text: message.delta,
      startMs: Math.round(message.start_ms),
      endMs: Math.round(message.end_ms),
    };
    pending.push(entry);
    onTranscript(entry);
    scheduleFlush();
  });

  channel.addEventListener('close', () => {
    resolveClosed();
    if (!didStart) rejectStarted(new Error('The voice connection closed before it was ready.'));
    else if (!closing && !cleaned) {
      onError('Voice disconnected. You can reconnect or keep typing.');
      stop(false).catch((error) => onError(error.message));
    }
  });

  peer.addEventListener('track', ({ track, streams }) => {
    audio.srcObject = streams[0] ?? new MediaStream([track]);
    audio.play().catch(() => onError('Audio playback is paused. Tap the voice panel to hear your partner.'));
  });

  peer.addEventListener('connectionstatechange', () => {
    if (peer.connectionState === 'failed' && !closing && !cleaned) {
      if (!didStart) rejectStarted(new Error('The network could not establish the voice connection.'));
      else {
        onError('The voice network connection failed. You can reconnect or keep typing.');
        stop(false).catch((error) => onError(error.message));
      }
    }
  });

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    connectionController.abort();
    clearTimeout(timer);
    timer = null;
    meter?.close();
    media?.getTracks().forEach((track) => track.stop());
    channel.close();
    peer.close();
    audio.srcObject = null;
  }

  async function connect() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access requires HTTPS or localhost.');
      meter = createMicrophoneMeter(onLevel);
      media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (cleaned) {
        media.getTracks().forEach((track) => track.stop());
        throw new DOMException('Voice connection was canceled.', 'AbortError');
      }
      meter?.attach(media);
      for (const track of media.getAudioTracks()) peer.addTrack(track, media);
      await peer.setLocalDescription(await peer.createOffer());
      await waitForIce(peer);
      const { sdp, greeting } = await api(sessionPath(sessionId, '/voice'), {
        method: 'POST', body: { sdp: peer.localDescription.sdp },
        signal: AbortSignal.any([connectionController.signal, AbortSignal.timeout(35_000)]),
      });
      await peer.setRemoteDescription({ type: 'answer', sdp });
      await Promise.race([started, timeout(15_000).then(() => { throw new Error('The voice connection timed out.'); })]);
      if (cleaned) throw new DOMException('Voice connection was canceled.', 'AbortError');
      send('session.commentary.append', {
        delegation_id: null,
        content: greeting ?? 'Begin the conversation now. Ask one short question in English, then listen.',
      });
      onState('connected');
      meter?.setActive(true);
    } catch (error) {
      const canceled = cleaned;
      cleanup();
      if (canceled) throw new DOMException('Voice connection was canceled.', 'AbortError');
      if (error.name === 'NotAllowedError') throw new Error('Microphone permission was denied. Allow access or type your reply.');
      if (error.name === 'NotFoundError') throw new Error('No microphone was found. Connect one or type your reply.');
      throw error;
    }
  }

  function stop(requestClose = true) {
    if (!closing) {
      closing = (async () => {
        try {
          if (requestClose && didStart && !cleaned) {
            setMuted(true);
            if (send('session.close')) await Promise.race([closed, timeout(2100)]);
          }
        } finally {
          cleanup();
          onState('idle');
        }
        await flush();
      })().finally(() => { closing = undefined; });
    }
    return closing;
  }

  function setMuted(muted) {
    for (const track of media?.getAudioTracks() ?? []) track.enabled = !muted;
    meter?.setActive(!muted);
  }

  return { connect, stop, setMuted };
}
