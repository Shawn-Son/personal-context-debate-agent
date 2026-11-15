export async function api(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(path, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    signal,
    credentials: 'same-origin',
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof payload?.error === 'string' ? payload.error : payload?.error?.message ?? payload?.message;
    throw new Error(message ?? `The request failed (${response.status}).`);
  }
  return payload;
}

export function sessionPath(id, suffix = '') {
  return `/api/sessions/${encodeURIComponent(id)}${suffix}`;
}
