// Deterministic fake issue tracker used by the agent benchmark.

export interface Issue {
  id: number;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  assignee: string | null;
  comments: number;
  created_at: string;
  body: string;
}

/** open issues labeled security, spread across all three pages of 100 */
export const SECURITY_OPEN = [17, 64, 118, 163, 207, 251, 289];
const SECURITY_CLOSED = [33, 140, 222];
export const ROOT_CAUSE_ID = 143;
export const ROOT_CAUSE =
  "Root cause: the session cache is keyed by the user's email alias, so two accounts sharing an alias overwrite each other's tokens.";
/** words a correct answer about the root cause must contain (any of them) */
export const ROOT_CAUSE_KEYWORDS = ['alias', 'email'];
export const TOTAL = 300;

const LABELS = ['bug', 'feature', 'docs', 'perf', 'ui', 'auth', 'api'];
const PEOPLE = ['alice', 'bob', 'carol', 'dmitry', 'erin', 'farid', null];
const AREAS = ['login page', 'billing export', 'search index', 'mobile sync', 'webhooks', 'admin panel', 'CSV import', 'notifications'];
const SYMPTOMS = ['hangs', 'returns 500', 'is slow', 'shows stale data', 'crashes', 'drops events', 'renders blank', 'times out'];
const FILLER = [
  'Steps to reproduce are attached below and were confirmed on staging.',
  'The problem started after the last deploy and affects several customers.',
  'Logs show repeated retries but no clear error message from the backend.',
  'We could not reproduce it locally with the default configuration.',
  'A temporary workaround is to refresh the page, but it is not acceptable for production.',
  'Related reports came from both the web app and the public API.',
  'Metrics show a spike in latency at the same time as the reports.',
  'Please check whether the feature flag rollout is related to this.',
];

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

export function issues(): Issue[] {
  const r = rng(7);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)]!;
  const out: Issue[] = [];
  for (let id = 1; id <= TOTAL; id++) {
    const area = pick(AREAS);
    const symptom = pick(SYMPTOMS);
    const labels = [pick(LABELS)];
    if (r() < 0.3) labels.push(pick(LABELS.filter((l) => l !== labels[0])));
    let state: Issue['state'] = r() < 0.6 ? 'open' : 'closed';
    if (SECURITY_OPEN.includes(id)) state = 'open';
    if (SECURITY_CLOSED.includes(id)) state = 'closed';
    if (SECURITY_OPEN.includes(id) || SECURITY_CLOSED.includes(id)) labels.push('security');
    const sentences = Array.from({ length: 14 }, () => pick(FILLER));
    const rootCause = id === ROOT_CAUSE_ID ? ROOT_CAUSE : 'Root cause: not identified yet.';
    out.push({
      id,
      title: `The ${area} ${symptom}`,
      state,
      labels,
      assignee: pick(PEOPLE),
      comments: Math.floor(r() * 25),
      created_at: new Date(Date.UTC(2026, 0, 1) + id * 86_400_000 * 0.9).toISOString().slice(0, 10),
      body: `The ${area} ${symptom} for some users. ${sentences.join(' ')} ${rootCause}`,
    });
  }
  return out;
}
