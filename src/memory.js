const kinds = new Set(['profile', 'preference', 'interest', 'viewpoint', 'goal']);
const operations = new Set(['add', 'update', 'forget']);
const keyFormat = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export const GENERAL_SCOPE = 'general_conversation';

export function normalizeText(value) {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function normalizeCandidate(candidate, userUtterances) {
  if (!candidate || !kinds.has(candidate.kind) || !operations.has(candidate.operation)) return null;
  if (candidate.assertion !== 'explicit' && candidate.assertion !== 'inferred') return null;
  if (typeof candidate.key !== 'string' || typeof candidate.value !== 'string') return null;

  const key = normalizeText(candidate.key);
  const scope = normalizeText(typeof candidate.scope === 'string' ? candidate.scope : GENERAL_SCOPE);
  const value = candidate.value.trim();
  if (!keyFormat.test(key) || key.length > 96 || !keyFormat.test(scope) || scope.length > 64) return null;
  if (value.length > 1200 || (!value && candidate.operation !== 'forget')) return null;

  const ids = Array.isArray(candidate.evidenceIds) ? [...new Set(candidate.evidenceIds)] : [];
  if (!ids.length || ids.length > 8) return null;
  const evidence = ids.map((id) => userUtterances.get(id));
  if (evidence.some((utterance) => !utterance || utterance.inRoleplay || utterance.transcriptStatus === 'uncertain')) {
    return null;
  }

  return {
    kind: candidate.kind,
    key,
    scope,
    value,
    assertion: candidate.assertion,
    operation: candidate.operation,
    evidence
  };
}

export function memoryDecision(existing, candidate) {
  if (existing?.status === 'deleted') return 'ignore';
  if (candidate.assertion === 'inferred') return !existing && candidate.operation === 'add' ? 'hold' : 'ignore';
  if (candidate.operation === 'forget') return 'forget';
  if (!existing || existing.status === 'candidate') return existing ? 'activate' : 'add';
  if (normalizeText(existing.value) === normalizeText(candidate.value)) return 'keep';
  if (candidate.operation === 'update') return 'update';
  return 'conflict';
}

function words(text) {
  return normalizeText(text).match(/[\p{L}\p{N}]{2,}/gu) ?? [];
}

export function selectMemories(memories, topic, scope, limit = 12) {
  const query = new Set(words(topic));
  const scoped = new Set(memories.filter((memory) =>
    memory.status === 'active' && memory.scope === scope && scope !== GENERAL_SCOPE
  ).map((memory) => `${memory.kind}/${memory.key}`));
  return memories
    .flatMap((memory) => {
      const general = memory.scope === GENERAL_SCOPE;
      if (memory.status !== 'active' || (!general && memory.scope !== scope)) return [];
      if (general && scoped.has(`${memory.kind}/${memory.key}`)) return [];
      const matches = [...new Set(words(`${memory.key} ${memory.value}`))].filter((word) => query.has(word)).length;
      const base = memory.kind === 'preference' ? 8 : memory.kind === 'goal' ? 6
        : memory.kind === 'interest' && !query.size ? 2 : 0;
      const score = base + matches * 3 + (general ? 0 : 4);
      return score ? [{ memory, score }] : [];
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ memory }) => memory);
}

export function curateFeedback(feedback, userUtterances) {
  if (!Array.isArray(feedback)) return [];
  const utterances = [...userUtterances.values()].filter((item) => item.transcriptStatus !== 'uncertain');

  return feedback.flatMap((item) => {
    if (!item || typeof item.original !== 'string' || typeof item.suggestion !== 'string' || typeof item.why !== 'string') {
      return [];
    }
    const original = item.original.trim();
    const suggestion = item.suggestion.trim();
    const why = item.why.trim();
    if (!original || !suggestion || !why || original.length > 500 || suggestion.length > 500 || why.length > 500 ||
        normalizeText(original) === normalizeText(suggestion)) return [];
    const evidence = utterances.find((entry) =>
      normalizeText(entry.text.replace(/[’‘]/g, "'")).includes(normalizeText(original.replace(/[’‘]/g, "'")))
    );
    return evidence ? [{ original, suggestion, why, evidenceId: evidence.id }] : [];
  }).slice(0, 4);
}
