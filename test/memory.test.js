import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openStore } from '../src/store.js';

function addUser(store, session, text, extra = {}) {
  return store.appendUtterances(session.id, [{ role: 'user', text, ...extra }]).utterances[0].id;
}

function feedbackTiming(value, evidenceIds, overrides = {}) {
  return {
    kind: 'preference', key: 'feedback.timing', value, scope: 'general_conversation',
    assertion: 'explicit', operation: 'add', evidenceIds, ...overrides
  };
}

test('bootstrap establishes a scoped memory and saves its evidence across restarts', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'context-debate-'));
  const path = join(directory, 'test.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const initial = openStore(path);
  const session = initial.createSession({ mode: 'bootstrap' });
  assert.equal(initial.needsBootstrap(), true);

  const quote = 'Please save feedback until after the conversation.';
  const evidenceId = addUser(initial, session, quote);
  const review = initial.endSession(session.id, { openQuestion: 'Want to practice giving a talk?' }, [
    feedbackTiming('after_session', [evidenceId])
  ]);
  assert.equal(review.review.changes[0].action, 'add');
  initial.close();

  const reopened = openStore(path);
  t.after(() => reopened.close());
  assert.equal(reopened.needsBootstrap(), false);
  assert.equal(reopened.getContext().memories[0].value, 'after_session');
  assert.equal(reopened.getContext().recentSessions[0].openQuestion, 'Want to practice giving a talk?');
  assert.deepEqual(reopened.listMemories()[0].evidence, [{ sessionId: session.id, utteranceId: evidenceId, quote }]);
});

test('deduplicates live events, stitches chunks, and isolates separate voice connections', (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const session = store.createSession({ mode: 'conversation', topic: 'How do cities change?' });
  const events = [
    { eventId: 'event_1', streamId: 'one', role: 'user', text: 'I prefer', startMs: 3000, endMs: 3200 },
    { eventId: 'event_2', streamId: 'one', role: 'user', text: ' short replies.', startMs: 3200, endMs: 3800 },
    { eventId: 'event_3', streamId: 'two', role: 'user', text: 'My microphone reconnected.', startMs: 100, endMs: 400 }
  ];
  const first = store.appendUtterances(session.id, events);
  assert.equal(first.accepted, 3);
  assert.equal(store.appendUtterances(session.id, events).accepted, 0);
  assert.deepEqual(store.listUtterances(session.id).map(({ id, text }) => ({ id, text })), [
    { id: first.utterances[0].id, text: 'I prefer short replies.' },
    { id: first.utterances[2].id, text: 'My microphone reconnected.' }
  ]);
});

test('requires explicit updates and keeps situation-specific preferences separate', (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  function finish(text, value, overrides = {}) {
    const session = store.createSession({ mode: 'conversation' });
    const evidence = addUser(store, session, text);
    const first = store.endSession(session.id, {}, [feedbackTiming(value, [evidence], overrides)]);
    assert.deepEqual(store.endSession(session.id, { summary: 'late retry' }).review, first.review);
    return first.review.changes[0].action;
  }
  assert.equal(finish('Feedback afterward, please.', 'after_session'), 'add');
  assert.equal(finish('I sometimes want feedback in the moment.', 'during_conversation'), 'conflict');
  assert.equal(finish('Only in debate, feedback in the moment.', 'during_conversation', { scope: 'debate' }), 'add');

  assert.equal(store.getContext().memories[0].value, 'after_session');
  const debateMemories = store.getContext({ topic: 'debate', scope: 'debate' }).memories;
  assert.equal(debateMemories.length, 1);
  assert.equal(debateMemories[0].value, 'during_conversation');

  assert.equal(finish('From now on, only correct me when I ask.', 'on_request', { operation: 'update' }), 'update');
  const memory = store.getContext().memories[0];
  assert.equal(memory.version, 2);
  assert.equal(memory.value, 'on_request');
  assert.throws(() => store.patchMemory(memory.id, { value: 'after_session', version: 1 }), { status: 409 });
});

test('retains weak candidates for review and rejects unrelated evidence and role-play', (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const prior = store.createSession({ mode: 'conversation' });
  const priorEvidence = addUser(store, prior, 'This is a separate session.');
  const session = store.createSession({ mode: 'conversation' });
  const rolePlay = addUser(store, session, 'I dislike debates.', { inRoleplay: true });
  const uncertain = addUser(store, session, 'I prefer [inaudible].', { transcriptStatus: 'uncertain' });
  const clear = addUser(store, session, 'My presentation is next week.');
  store.endSession(session.id, {
    feedback: [{ original: 'I prefer correcting', suggestion: 'I prefer corrections', why: 'Use the noun.' }]
  }, [
    feedbackTiming('after_session', [priorEvidence]),
    feedbackTiming('on_request', [rolePlay]),
    feedbackTiming('after_session', [uncertain]),
    feedbackTiming('during_conversation', [clear], { assertion: 'inferred' })
  ]);
  assert.equal(store.listMemories().length, 1);
  assert.equal(store.listMemories()[0].status, 'candidate');
  assert.equal(store.getContext().memories.length, 0);
  assert.deepEqual(store.getSession(session.id).review.feedback, []);
});

test('direct editing wins against stale auto-updates and forgetting suppresses conversational reuse', (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const initial = store.createSession({ mode: 'conversation', topic: 'Feedback timing' });
  const evidenceId = addUser(store, initial, 'My preference is feedback after we finish.');
  store.endSession(initial.id, { summary: 'The learner likes feedback afterward.' }, [
    feedbackTiming('after_session', [evidenceId])
  ]);

  const memory = store.listMemories()[0];
  const staleSession = store.createSession({ mode: 'conversation' });
  const staleEvidence = addUser(store, staleSession, 'Change my preference to immediate feedback.');
  const edited = store.patchMemory(memory.id, { value: 'on_request', version: memory.version });
  assert.equal(edited.value, 'on_request');
  store.endSession(staleSession.id, {}, [feedbackTiming('during_conversation', [staleEvidence], { operation: 'update' })]);
  assert.equal(store.listMemories()[0].value, 'on_request');

  assert.equal(store.deleteMemory(memory.id), true);
  assert.deepEqual(store.getContext().recentSessions, []);
  assert.equal(store.listUtterances(initial.id)[0].id, evidenceId);
  const next = store.createSession({ mode: 'conversation' });
  const nextEvidence = addUser(store, next, 'Back when we discussed feedback after each session.');
  store.endSession(next.id, { summary: 'Feedback after each session came up again.' }, [
    feedbackTiming('after_session', [nextEvidence])
  ]);
  assert.deepEqual(store.listMemories(), []);
  assert.deepEqual(store.getContext().recentSessions, []);
});
