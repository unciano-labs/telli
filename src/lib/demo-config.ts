// Shared by client and server: demo scenarios shown on /demo

export const DEMO_SCENARIOS = [
  {
    id: 'support',
    name: 'Our support agent',
    description: 'The live agent from this site, trained on our own documents.',
    tryAsking: ['What can your voice agent do?', 'How do I add it to my website?'],
  },
  {
    id: 'clinic',
    name: 'Dental clinic receptionist',
    description: 'Answers questions about services and prices, and books appointments.',
    tryAsking: ['How much is a cleaning?', 'Can I book for Saturday morning?'],
  },
  {
    id: 'real_estate',
    name: 'Real estate inquiry',
    description: 'Qualifies a buyer: budget, location, timeline, then sets a viewing.',
    tryAsking: ['I’m looking for a condo in BGC', 'My budget is around 8 million'],
  },
  {
    id: 'online_store',
    name: 'Online store support',
    description: 'Tracks orders and explains returns and shipping.',
    tryAsking: ['Where is order 1042?', 'Can I return a shirt that doesn’t fit?'],
  },
  {
    id: 'rental',
    name: 'Short-term rental host',
    description: 'Helps guests pick an apartment, quotes the stay, books it, and answers check-in questions.',
    tryAsking: ['Do you have a place for 4 people next weekend?', 'What time is check-in, and is there parking?'],
  },
] as const;

export type DemoScenarioId = (typeof DEMO_SCENARIOS)[number]['id'];

export function isDemoScenario(value: unknown): value is DemoScenarioId {
  return DEMO_SCENARIOS.some((s) => s.id === value);
}

/**
 * Languages the sample businesses can speak. Retell has no speech recognizer that covers
 * Filipino together with the others, so Filipino is its own per-call mode.
 */
export const DEMO_LANGUAGES = [
  {
    id: 'multi',
    label: 'Multilingual',
    description: 'English, Spanish, French, German, Chinese, Japanese, Arabic and 14 more. Just start talking.',
  },
  {
    id: 'fil',
    label: 'Filipino / Taglish',
    description: 'Tuned for Filipino, including Taglish.',
  },
] as const;

export type DemoLanguageId = (typeof DEMO_LANGUAGES)[number]['id'];

export function isDemoLanguage(value: unknown): value is DemoLanguageId {
  return DEMO_LANGUAGES.some((l) => l.id === value);
}

/** Allowance shown on /demo, from va_demo_status. */
export type DemoStatus = {
  enabled: boolean;
  allowanceSeconds: number;
  usedSeconds: number;
  remainingSeconds: number;
  inProgress: boolean;
  /** Demo spending hit today's budget: nobody can start a call until tomorrow. */
  budgetReached: boolean;
};

/** A call shorter than this isn't worth starting; mirrors va_demo_reserve. */
export const MIN_DEMO_CALL_SECONDS = 15;
