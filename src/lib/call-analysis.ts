// Post-call analysis shared by the server (Retell setup, webhook) and the studio UI.
// Retell adds these fields to its built-in summary, sentiment and "call successful".

export const CALLER_INTENTS = {
  information: 'Asking for information',
  pricing: 'Prices and quotes',
  booking: 'Booking or appointment',
  order_or_account: 'Existing order or account',
  complaint: 'Complaint or problem',
  sales: 'Wants to buy or sign up',
  other: 'Something else',
} as const;

export type CallerIntent = keyof typeof CALLER_INTENTS;

export const MAX_QUESTIONS_PER_CALL = 5;

/** Custom post-call analysis on every workspace agent (and on each live call as an override). */
export const ANALYSIS_FIELDS = [
  {
    type: 'boolean' as const,
    name: 'resolved',
    description:
      'True if the agent fully answered or handled what the caller needed. False if the caller left without an answer, was told to call back or contact someone else for something the agent should know, or hung up frustrated.',
  },
  {
    type: 'string' as const,
    name: 'unanswered_questions',
    description:
      'Each question the caller asked that the agent could not answer or answered with "I don\'t know", one per line, rewritten as a short standalone question in English (e.g. "Do you open on Sundays?"). Leave empty if the agent answered everything.',
    examples: ['Do you accept GCash?\nIs there parking near the clinic?', ''],
  },
  {
    type: 'enum' as const,
    name: 'caller_intent',
    description: 'The main reason the caller called.',
    choices: Object.keys(CALLER_INTENTS),
  },
];

const NO_QUESTIONS = /^(none|n\/a|na|nothing|no|null|-|empty)\.?$/i;

/** Splits the analysis' unanswered_questions text into clean, de-duplicated questions. */
export function parseUnansweredQuestions(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const seen = new Set<string>();
  const questions: string[] = [];
  for (const line of value.split(/\n|;|\s\|\s/)) {
    const q = line
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
      .replace(/^["“]|["”]$/g, '')
      .trim()
      .slice(0, 300);
    if (!q || NO_QUESTIONS.test(q) || seen.has(q.toLowerCase())) continue;
    seen.add(q.toLowerCase());
    questions.push(q);
  }
  return questions.slice(0, MAX_QUESTIONS_PER_CALL);
}

/** Retell sends booleans, but older or custom analyses may send "true"/"false". */
export function parseResolved(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'True') return true;
  if (value === 'false' || value === 'False') return false;
  return null;
}

export function parseIntent(value: unknown): CallerIntent | null {
  return typeof value === 'string' && value in CALLER_INTENTS ? (value as CallerIntent) : null;
}

export type Utterance = { role: 'agent' | 'user'; content: string };

/** Splits Retell's plain-text transcript ("Agent: …\nUser: …") into utterances. */
export function parseTranscript(text: string | null): Utterance[] {
  if (!text) return [];
  const utterances: Utterance[] = [];
  for (const line of text.split('\n')) {
    const match = /^(Agent|User):\s?(.*)$/.exec(line);
    if (match) {
      utterances.push({ role: match[1] === 'Agent' ? 'agent' : 'user', content: match[2].trim() });
    } else if (line.trim() && utterances.length) {
      utterances[utterances.length - 1].content += `\n${line.trim()}`;
    }
  }
  return utterances.filter((u) => u.content);
}

const STOP_WORDS = new Set(
  'a an the is are am do does did can could would will i you we your our my me to of for in on at it this that there be have has with and or how what when where which who much many any about please po ba'.split(
    ' '
  )
);

function keywords(question: string) {
  return new Set(
    question
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w && !STOP_WORDS.has(w))
      .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
  );
}

function similarity(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Groups questions that share most of their keywords ("Open on Sunday?" / "Are you open Sundays?"). */
export function groupSimilar<T extends { question: string }>(items: T[], threshold = 0.5): T[][] {
  const groups: { words: Set<string>; items: T[] }[] = [];
  for (const item of items) {
    const words = keywords(item.question);
    const match = groups.find((g) => similarity(g.words, words) >= threshold);
    if (match) match.items.push(item);
    else groups.push({ words, items: [item] });
  }
  return groups.map((g) => g.items);
}
