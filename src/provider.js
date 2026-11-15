import {
  bootstrapFields,
  conversationInstructions,
  liveInstructions,
  previewReply,
  promptOpening,
  reasoningInstructions,
  reviewInstructions,
} from './prompts.js';

const OPENAI_API = 'https://api.openai.com/v1';
const VOICE_MODEL = 'gpt-live-1';
const TEXT_MODEL = 'gpt-6-luna';
const DEFAULT_VOICE = 'marin';
const MAX_MEMORY_ENTRIES = 18;
const REQUEST_TIMEOUT = 30_000;
const REVIEW_TIMEOUT = 50_000;
// Live startup history allows 8,192 tokens. A byte budget also leaves room for
// message framing and preserves valid JSON across languages.
const LIVE_STARTUP_BUDGET = 7_000;

const string = { type: 'string' };
const enumString = (...values) => ({ type: 'string', enum: values });
const array = (items) => ({ type: 'array', items });
const object = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const reviewSchema = object({
  summary: string,
  openQuestion: string,
  feedback: array(object({ original: string, suggestion: string, why: string })),
  candidates: array(object({
    kind: enumString('profile', 'preference', 'interest', 'viewpoint', 'goal'),
    key: string,
    value: string,
    scope: string,
    assertion: enumString('explicit', 'inferred'),
    operation: enumString('add', 'update', 'forget'),
    evidenceIds: array(string),
  })),
});

export class ProviderError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
  }
}

function clip(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function isSpeaker(role) {
  return role === 'user' || role === 'assistant';
}

function contextPayload(context = {}) {
  return {
    memories: (context.memories ?? []).filter((memory) => !memory.status || memory.status === 'active')
      .slice(0, MAX_MEMORY_ENTRIES)
      .map(({ kind, key, value, scope }) => ({ kind, key, value: clip(value, 360), scope })),
    recentSessions: (context.recentSessions ?? []).slice(0, 3)
      .map(({ topic, summary, openQuestion, review }) => ({
        topic: clip(topic, 160),
        summary: clip(summary || review?.summary, 520),
        openQuestion: clip(openQuestion || review?.openQuestion, 240),
      })),
    learning: (context.learning ?? []).slice(0, 5)
      .map(({ original, suggestion, why }) => ({
        original: clip(original, 150),
        suggestion: clip(suggestion, 180),
        why: clip(why, 150),
      })),
  };
}

function sessionPayload(session) {
  return {
    mode: session.mode,
    topic: clip(session.topic, 200),
    style: session.style,
    language: session.language,
  };
}

function transcriptPayload(utterances = [], maxChars = 60_000) {
  const transcript = [];
  let chars = 0;
  for (let index = utterances.length - 1; index >= 0; index -= 1) {
    const entry = utterances[index];
    const text = clip(entry.text, 4500);
    if (!isSpeaker(entry.role) || !text) continue;
    if (chars + text.length + 128 > maxChars) break;
    transcript.push({
      id: entry.id,
      role: entry.role,
      text,
      inRoleplay: entry.inRoleplay === true,
      transcriptStatus: entry.transcriptStatus ?? undefined,
    });
    chars += text.length + 128;
  }
  return transcript.reverse();
}

function responseText(payload) {
  if (!payload || payload.status !== 'completed' || !Array.isArray(payload.output)) {
    throw new ProviderError(502, 'The model did not finish the response. Please try again.', 'provider_incomplete');
  }
  const contents = payload.output
    .filter((item) => item.type === 'message' && Array.isArray(item.content))
    .flatMap((item) => item.content);
  if (contents.some((part) => part.type === 'refusal')) {
    throw new ProviderError(422, 'The model could not answer that request. Try rephrasing it.', 'provider_refusal');
  }
  const output = contents.filter((part) => part.type === 'output_text').map((part) => part.text).join('').trim();
  if (!output) throw new ProviderError(502, 'The model returned an empty response. Please try again.', 'provider_empty');
  return output;
}

function parseReview(output, transcript) {
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw new ProviderError(502, 'The session review could not be read. Please try again.', 'provider_invalid_review');
  }
  if (!result || typeof result.summary !== 'string' || typeof result.openQuestion !== 'string'
      || !Array.isArray(result.feedback) || !Array.isArray(result.candidates)) {
    throw new ProviderError(502, 'The session review was incomplete. Please try again.', 'provider_invalid_review');
  }

  const spoken = transcript.filter(({ role }) => role === 'user');
  const feedback = result.feedback.slice(0, 3).flatMap((item) => {
    const original = clip(item?.original, 400);
    const suggestion = clip(item?.suggestion, 450);
    const why = clip(item?.why, 450);
    return original && suggestion && why && spoken.some(({ text }) => text.includes(original))
      ? [{ original, suggestion, why }]
      : [];
  });
  return {
    summary: clip(result.summary, 3500),
    openQuestion: clip(result.openQuestion, 700),
    feedback,
    candidates: result.candidates.slice(0, 8),
  };
}

function offlineReview(session, utterances) {
  const userTurns = utterances.filter(({ role, text }) => role === 'user' && clip(text, 600));
  const candidates = session.mode === 'bootstrap'
    ? bootstrapFields.flatMap((field, index) => {
      const turn = userTurns[index];
      const value = clip(turn?.text, 600);
      if (!turn?.id || !value || /^(?:skip|no|unsure|not sure|건너뛰기|모르겠어요)[.!?]?$/iu.test(value)) return [];
      return [{
        ...field, value, scope: 'general_conversation', assertion: 'explicit',
        operation: 'add', evidenceIds: [turn.id],
      }];
    })
    : [];
  const lastTurn = clip(userTurns.at(-1)?.text, 220);
  return {
    summary: userTurns.length
      ? `Practice preview recorded ${userTurns.length} ${userTurns.length === 1 ? 'response' : 'responses'}.`
        + `${lastTurn ? ` Last response: “${lastTurn}”` : ''}`
      : 'There were no learner responses in this session.',
    openQuestion: userTurns.length && session.mode === 'conversation' ? previewReply(session, utterances) : '',
    feedback: [],
    candidates,
  };
}

function voiceGreeting(session, hasUserTurns) {
  const language = session.mode === 'bootstrap' && session.language === 'ko' ? 'Korean' : 'English';
  return hasUserTurns
    ? `Continue the conversation now in ${language}. Pick up the last exchange with one short question, then listen.`
    : `Begin the conversation now in ${language}. Use the opening question in your session context, then listen.`;
}

function liveMessage(role, message) {
  return {
    type: 'message',
    role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: message }],
  };
}

export function createProvider({
  apiKey = process.env.OPENAI_API_KEY,
  voiceModel = process.env.OPENAI_VOICE_MODEL || VOICE_MODEL,
  textModel = process.env.OPENAI_TEXT_MODEL || TEXT_MODEL,
  voice = process.env.OPENAI_VOICE || DEFAULT_VOICE,
  fetchImpl = fetch,
} = {}) {
  const configured = typeof apiKey === 'string' && Boolean(apiKey.trim());

  async function call(endpoint, body, signal, timeout = REQUEST_TIMEOUT) {
    const timeoutSignal = AbortSignal.timeout(timeout);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response;
    try {
      response = await fetchImpl(`${OPENAI_API}${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: requestSignal,
      });
    } catch {
      if (timeoutSignal.aborted) throw new ProviderError(504, 'The model took too long. Please try again.', 'provider_timeout');
      if (signal?.aborted) throw new ProviderError(499, 'The request was cancelled.', 'provider_cancelled');
      throw new ProviderError(502, 'Could not connect to the model provider. Please try again.', 'provider_connection');
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 429) {
        throw new ProviderError(503, 'The model provider is temporarily at its usage limit. Try again later.', 'provider_limit');
      }
      if (response.status === 401 || response.status === 403) {
        throw new ProviderError(503, 'Check the OpenAI project key and its model access.', 'provider_access');
      }
      throw new ProviderError(502, 'The model provider could not process the request. Check your model settings and try again.', 'provider_request');
    }
    try {
      return await response.json();
    } catch {
      if (timeoutSignal.aborted) throw new ProviderError(504, 'The model took too long. Please try again.', 'provider_timeout');
      if (signal?.aborted) throw new ProviderError(499, 'The request was cancelled.', 'provider_cancelled');
      throw new ProviderError(502, 'The model provider returned an unreadable response.', 'provider_invalid_response');
    }
  }

  async function connectVoice({ sdp, session, context, utterances = [], signal }) {
    if (!configured) {
      throw new ProviderError(503, 'Voice is unavailable until an OpenAI project key is configured.', 'provider_unconfigured');
    }
    const hasUserTurns = utterances.some(({ role }) => role === 'user');
    const greeting = voiceGreeting(session, hasUserTurns);
    const background = contextPayload(context);
    const startupContext = {
      session: sessionPayload(session),
      background,
      suggestedOpening: hasUserTurns ? '' : promptOpening(session, background),
    };
    let startup = JSON.stringify(startupContext);
    while (Buffer.byteLength(startup) > 3_600) {
      if (background.learning.length) background.learning.pop();
      else if (background.memories.length) background.memories.pop();
      else if (background.recentSessions.length) background.recentSessions.pop();
      else break;
      startup = JSON.stringify(startupContext);
    }
    const history = [];
    let budget = LIVE_STARTUP_BUDGET - Buffer.byteLength(startup) - Buffer.byteLength(greeting) - 128;
    if (hasUserTurns) {
      const recent = transcriptPayload(utterances.slice(-18), 6500);
      for (const { role, text } of recent.reverse()) {
        const size = Buffer.byteLength(text) + 48;
        if (size > budget) break;
        history.unshift(liveMessage(role, text));
        budget -= size;
      }
    }
    const input = [liveMessage('developer', greeting), liveMessage('user', startup), ...history];
    const payload = await call('/live/sessions', {
      transport: { type: 'webrtc', sdp },
      session: {
        model: voiceModel,
        instructions: liveInstructions(session, hasUserTurns),
        input,
        audio: { output: { voice } },
        store: false,
        client: {
          data_channel: {
            allowed_client_events: ['session.commentary.append', 'session.close'],
          },
        },
        delegation: {
          type: 'responses',
          responses: {
            model: textModel,
            instructions: reasoningInstructions,
            max_output_tokens: 650,
          },
        },
      },
    }, signal);
    const answer = payload?.transport?.sdp;
    if (typeof answer !== 'string' || !answer.startsWith('v=0')) {
      throw new ProviderError(502, 'The voice session did not return a valid connection answer.', 'provider_invalid_sdp');
    }
    return { sdp: answer, greeting };
  }

  async function reply({ session, context, utterances = [], signal }) {
    if (!configured) return previewReply(session, utterances);
    const response = await call('/responses', {
      model: textModel,
      instructions: conversationInstructions(session),
      input: JSON.stringify({
        session: sessionPayload(session),
        background: contextPayload(context),
        conversation: transcriptPayload(utterances, 28_000),
      }),
      store: false,
      max_output_tokens: 800,
    }, signal);
    return responseText(response);
  }

  async function review({ session, context, utterances = [], signal }) {
    if (!configured) return offlineReview(session, utterances);
    const transcript = transcriptPayload(utterances);
    if (!transcript.some(({ role }) => role === 'user')) return offlineReview(session, utterances);
    const response = await call('/responses', {
      model: textModel,
      instructions: reviewInstructions,
      input: JSON.stringify({
        session: sessionPayload(session),
        background: contextPayload(context),
        conversation: transcript,
      }),
      store: false,
      max_output_tokens: 3200,
      text: {
        format: {
          type: 'json_schema',
          name: 'session_review',
          strict: true,
          schema: reviewSchema,
        },
      },
    }, signal, REVIEW_TIMEOUT);
    return parseReview(responseText(response), transcript);
  }

  return {
    voiceAvailable: configured,
    reviewAvailable: configured,
    opening: ({ session, context }) => promptOpening(session, context),
    connectVoice,
    reply,
    review,
  };
}
