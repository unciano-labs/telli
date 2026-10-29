// Builds an agent's system prompt. Shared by the server (what Retell gets) and the profile
// form (live preview). Three parts, in order:
//   1. Platform rules: AI disclosure and safety. Always on; workspaces can't edit them.
//   2. The body: generated from the business profile, or the owner's own Advanced prompt.
//   3. Rules the team added (manually or from corrected calls).

import { getTemplate, isTemplateId, type TemplateId } from '@/lib/templates';

export type Tone = 'friendly' | 'formal' | 'taglish';
export type PromptMode = 'profile' | 'advanced';

export type BusinessProfile = {
  businessName: string;
  industry: TemplateId;
  about: string;
  services: string;
  hours: string;
  location: string;
  policies: string;
  tone: Tone;
  avoid: string;
  handoff: string;
};

export const TONES: { id: Tone; label: string; line: string }[] = [
  { id: 'friendly', label: 'Friendly', line: 'Be warm, upbeat and casual, like a helpful front-desk person.' },
  { id: 'formal', label: 'Formal', line: 'Be polite and professional. Use "po" and "opo" when speaking Filipino.' },
  {
    id: 'taglish',
    label: 'Taglish',
    line: 'Speak naturally in Taglish (a mix of Filipino and English) unless the caller sticks to one language.',
  },
];

/** Longest body (profile text or Advanced prompt) a workspace can save. */
export const MAX_PROMPT_CHARS = 12_000;
export const MAX_FIELD_CHARS = 3_000;
export const MAX_RULES = 50;

export const PROFILE_FIELDS = ['about', 'services', 'hours', 'location', 'policies', 'avoid', 'handoff'] as const;

export function emptyProfile(businessName: string, industry: TemplateId): BusinessProfile {
  return {
    businessName,
    industry,
    about: '',
    services: '',
    hours: '',
    location: '',
    policies: '',
    tone: 'friendly',
    avoid: '',
    handoff: '',
  };
}

/** Reads a stored profile, filling gaps so older or partial rows still build a prompt. */
export function normalizeProfile(value: unknown, fallbackName: string, fallbackIndustry: TemplateId): BusinessProfile {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : '');
  const profile = emptyProfile(text('businessName') || fallbackName, isTemplateId(raw.industry) ? raw.industry : fallbackIndustry);
  for (const field of PROFILE_FIELDS) profile[field] = text(field);
  if (TONES.some((t) => t.id === raw.tone)) profile.tone = raw.tone as Tone;
  return profile;
}

export function platformRules(businessName: string) {
  return `## Always (set by the platform)
- You are an AI voice assistant for ${businessName}. If someone asks whether they're talking to a person or a machine, say you're an AI assistant.
- Never ask for or repeat card numbers, CVV codes, passwords, one-time PINs or government ID numbers.
- Don't give medical, legal or financial advice beyond the business's own published information.
- If a caller describes an emergency, tell them to contact local emergency services right away.
- When the caller says goodbye or has nothing else to ask, say a short goodbye and end the call.`;
}

function section(title: string, body: string) {
  const text = body.trim();
  return text ? `### ${title}\n${text}` : '';
}

/** The prompt body generated from a business profile. */
export function profileBody(profile: BusinessProfile, agentName: string) {
  const name = profile.businessName.trim() || 'the business';
  const tone = TONES.find((t) => t.id === profile.tone) ?? TONES[0];
  const details = [
    section('Services and prices', profile.services),
    section('Opening hours', profile.hours),
    section('Location', profile.location),
    section('Policies', profile.policies),
  ].filter(Boolean);

  return [
    `You are ${agentName}, the voice assistant for ${name}.${profile.about.trim() ? ` ${profile.about.trim()}` : ''}`,
    getTemplate(profile.industry).job(name),
    details.length ? `## About the business\n${details.join('\n\n')}` : '',
    `## How to talk
- ${tone.line}
- This is a phone call: keep answers short (one to three sentences) and ask one question at a time.
- Reply in the caller's language, and switch if they switch.
- Say prices, times and numbers the way a person would say them out loud.`,
    `## Ground rules
- Answer only from the knowledge base and the details in this prompt. If you don't know, say so and offer to have the team follow up.
- Never make up prices, availability, policies or order details.
- Before ending, confirm anything you agreed to and ask if there's anything else.`,
    profile.avoid.trim() ? `## Topics to avoid\n${profile.avoid.trim()}` : '',
    profile.handoff.trim() ? `## When to hand off to a person\n${profile.handoff.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildPrompt(input: {
  mode: PromptMode;
  profile: BusinessProfile;
  customPrompt: string | null;
  rules: string[];
  agentName: string;
  /** Sections the platform adds after the business's part, e.g. booking instructions from modules. */
  extra?: string;
}) {
  const body = input.mode === 'advanced' ? (input.customPrompt ?? '').trim() : profileBody(input.profile, input.agentName);
  const rules = input.rules.map((r) => r.trim()).filter(Boolean);
  return [
    platformRules(input.profile.businessName.trim() || 'this business'),
    body,
    input.extra?.trim() ?? '',
    rules.length ? `## Rules from the team\n${rules.map((r) => `- ${r}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

// Lines that tell the agent to collect secrets, pass as a human, or hide that it's an AI.
// The first two are fine when negated ("never ask for card numbers"); the third is a negation.
const UNSAFE: { pattern: RegExp; reason: string; allowNegated: boolean }[] = [
  {
    pattern:
      /\b(ask|collect|get|take|request|record|note|confirm|read back)\b[^.\n]{0,60}\b(card numbers?|credit cards?|debit cards?|cvv|cvc|security codes?|passwords?|pins?|one[- ]time (pins?|passwords?|codes?)|otps?)\b/i,
    reason: 'collects card numbers, passwords or one-time codes',
    allowNegated: true,
  },
  {
    pattern: /\b(pretend|claim|say|insist|act)\b[^.\n]{0,40}\b(you are|you're|to be|as)\b[^.\n]{0,20}\b(a )?(human|real person|live person)\b/i,
    reason: 'pretends to be a human',
    allowNegated: true,
  },
  {
    pattern: /\b(never|don't|do not)\b[^.\n]{0,20}\b(say|admit|reveal|tell|mention|disclose)\b[^.\n]{0,40}\b(ai|a bot|robot|artificial|machine)\b/i,
    reason: 'hides that the caller is talking to an AI',
    allowNegated: false,
  },
];
const NEGATION = /\b(never|don't|do not|not|no|without)\b/i;

/** Problems that block publishing, e.g. "“Ask for their card number” collects card numbers…". Empty when safe. */
export function findUnsafeInstructions(text: string): string[] {
  const problems: string[] = [];
  for (const line of text.split('\n')) {
    for (const { pattern, reason, allowNegated } of UNSAFE) {
      const match = pattern.exec(line);
      if (!match) continue;
      if (allowNegated && NEGATION.test(line.slice(0, match.index + match[0].length))) continue;
      problems.push(`“${line.trim().slice(0, 80)}” ${reason}.`);
    }
  }
  return problems;
}
