import assert from 'node:assert/strict';
import test from 'node:test';
import { createProvider } from '../src/provider.js';

const session = { mode: 'bootstrap', language: 'en', style: 'explore' };
const utterances = [{ id: 'u1', role: 'user', text: 'I want present research clearly.' }];
const context = {
  memories: [
    { kind: 'goal', key: 'english.speaking_goal', scope: 'general_conversation', status: 'active', value: 'Join team discussions' },
    { kind: 'interest', key: 'topic.old', scope: 'general_conversation', status: 'deleted', value: 'Removed memory' },
  ],
};

function modelResponse(text) {
  return Response.json({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  });
}

test('exchanges an authenticated Live WebRTC offer and seeds a bounded, durable context', async () => {
  const provider = createProvider({
    apiKey: 'fixture-key',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/live/sessions');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer fixture-key');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.ok(options.signal instanceof AbortSignal);
      const body = JSON.parse(options.body);
      assert.deepEqual(body.transport, { type: 'webrtc', sdp: 'v=0\r\n' });
      assert.equal(body.session.model, 'gpt-live-1');
      assert.equal(body.session.audio.output.voice, 'marin');
      assert.equal(body.session.store, false);
      assert.deepEqual(body.session.client.data_channel.allowed_client_events, ['session.commentary.append', 'session.close']);
      assert.equal(body.session.delegation.type, 'responses');
      assert.equal(body.session.delegation.responses.model, 'gpt-6-luna');
      assert.equal(body.session.delegation.responses.tools, undefined);
      const [greeting, background, last] = body.session.input;
      assert.equal(greeting.role, 'developer');
      assert.match(greeting.content[0].text, /Continue the conversation now in English/);
      assert.equal(background.role, 'user');
      const { background: { memories } } = JSON.parse(background.content[0].text);
      assert.deepEqual(memories.map(({ value }) => value), ['Join team discussions']);
      assert.equal(last.content[0].text, utterances[0].text);
      return Response.json({ transport: { sdp: 'v=0\r\n' } }, { status: 201 });
    },
  });
  const answer = await provider.connectVoice({ sdp: 'v=0\r\n', session, context, utterances });
  assert.equal(answer.sdp, 'v=0\r\n');
  assert.match(answer.greeting, /Continue the conversation now in English/);
});

test('uses contextual text replies and grounds review feedback in supplied evidence', async () => {
  const evidenceIds = ['u1'];
  const provider = createProvider({
    apiKey: 'fixture-key',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(options.body);
      assert.equal(body.store, false);
      const input = JSON.parse(body.input);
      assert.equal(input.background.memories[0].key, 'english.speaking_goal');
      assert.equal(input.conversation[0].id, 'u1');
      if (!body.text) return modelResponse('Which talk is coming up next?');
      assert.equal(body.text.format.strict, true);
      assert.equal(body.text.format.type, 'json_schema');
      return modelResponse(JSON.stringify({
        summary: 'The learner wants to present research clearly.',
        openQuestion: 'What audience will you present to?',
        feedback: [
          { original: 'want present', suggestion: 'want to present', why: 'Use an infinitive after want.' },
          { original: 'fabricated quote', suggestion: 'ignored', why: 'ignored' },
        ],
        candidates: [{
          kind: 'goal',
          key: 'english.speaking_goal',
          value: 'Present research clearly',
          scope: 'general_conversation',
          assertion: 'explicit',
          operation: 'add',
          evidenceIds,
        }],
      }));
    },
  });
  assert.equal(await provider.reply({ session, context, utterances }), 'Which talk is coming up next?');
  const review = await provider.review({ session, context, utterances });
  assert.deepEqual(review.feedback.map(({ original }) => original), ['want present']);
  assert.deepEqual(review.candidates[0].evidenceIds, evidenceIds);
});

test('offers a scripted starter interview and a preview review without credentials', async () => {
  const provider = createProvider({
    apiKey: '',
    fetchImpl: async () => { assert.fail('An offline rehearsal must not contact OpenAI.'); },
  });
  assert.equal(provider.voiceAvailable, false);
  assert.equal(provider.reviewAvailable, false);
  assert.match(provider.opening({ session, context }), /spoken English/);
  assert.match(await provider.reply({ session, context, utterances }), /topics/);
  const review = await provider.review({ session, context, utterances });
  assert.match(review.summary, /Practice preview/);
  assert.deepEqual(review.feedback, []);
  assert.deepEqual(review.candidates[0].evidenceIds, ['u1']);
  await assert.rejects(provider.connectVoice({ sdp: 'v=0\r\n', session }), {
    status: 503,
    code: 'provider_unconfigured',
  });
});

test('exposes a safe error when the provider rejects credentials', async () => {
  const provider = createProvider({
    apiKey: 'fixture-key',
    fetchImpl: async () => new Response('Upstream details that must stay private.', { status: 403 }),
  });
  await assert.rejects(provider.reply({ session, utterances }), {
    name: 'ProviderError',
    status: 503,
    code: 'provider_access',
    message: 'Check the OpenAI project key and its model access.',
  });
});
