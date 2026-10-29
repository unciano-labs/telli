# Voice Agent — Product Roadmap

This roadmap takes the MVP in `CLAUDE.md` to a product we can charge for:
- an **embeddable widget with usage tracking**,
- a **public demo** with a 5-minute allowance per user,
- **phone numbers** that customers choose or buy,
- **customers training their own agent** from real calls,
- then **customer workspaces**, **billing** and **agent actions**.

Each phase lists its tasks, what it delivers, and a **Done when** check. Tick tasks off as they ship.

**Order:**
- Phases 1 and 2 can ship to the current single agent right away.
- Phase 3 (workspaces) is needed before outside customers can sign up. It comes before:
  - training (4), which is done per customer;
  - buying numbers per customer (5);
  - billing (6).
- Training uses the call transcripts from Phase 1.

| Phase | Theme | Status |
| :--- | :--- | :--- |
| 0 | MVP: dialer, admin, knowledge base, outbound calls | ✅ Done |
| 1 | Call tracking + embeddable widget | ✅ Done |
| 2 | Public demo (5 minutes per user) | 🧪 Live: migration run, scenarios verified; 5-minute cutoff still to test |
| 3 | Workspaces: one account per customer business | 🧪 Live: migration run, isolation test passes (47/47); end-to-end onboarding still to try |
| 4 | Agent training studio: customers teach and test their agent | ✅ Live: teach, test, publish, history, guardrails, learn from calls. `studio-test` 27/27, `improve-test` 41/41. AI suggestions not built |
| 5 | Phone numbers: choose, buy or bring your own | 🟡 Built; `numbers-test` 34/34 with imported numbers. Buying waits on a card in Retell, Twilio on credentials, plus a real phone call |
| 6 | Plans, billing and usage limits | ✅ USD plans paid in PHP via PayMongo, limits, revenue view. `billing-test` 40/40 (test-mode payments). No emails yet |
| 7 | Agent actions: booking, data lookup, transfer to a human | 🟡 Booking modules verified (`modules-test` 42/42); live calls need a public URL. Lookup, transfer, campaigns next |
| 8 | Launch hardening and compliance | Planned |

---

## Phase 0 — MVP (done)

**Deliverable:** A working voice support portal for one agent.

- [x] Next.js 16 app with Supabase auth, isolated to `WEBSITE_ID` (login/signup rules, `admin`/`user` roles)
- [x] Public landing page with a browser dialer (`RetellWebClient`), live transcript, mute and hang-up
- [x] `POST /api/call/create`: per-IP rate limit (5 per 10 minutes), 5-minute call cap
- [x] Admin agent settings synced to Retell: name, voice, speed, greeting, system prompt
- [x] Knowledge base: signed uploads to Supabase Storage → Retell KB, indexing status, delete
- [x] Outbound calls from the admin page: caller ID picker, greeting template, consent checkbox, transcript and summary
- [x] Twilio number `+15677575800` imported into Retell over a SIP trunk (PH + US)

**Known limits carried forward:**
- Only outbound calls are logged. Web calls are not.
- Twilio is a trial account, so it can only call verified numbers.
- There is one agent for the whole app (`WEBSITE_ID` in env), not one per customer.

---

## Phase 1 — Call tracking + embeddable widget

**Goal:** Any website can add the voice agent with one `<script>` tag, and every call (web or phone) is recorded with duration, cost and outcome.

### 1A. Call tracking foundation
- [x] **Migration `va_call_logs` v2:**
  - [x] Add `widget_id`, `source` (`landing` | `widget` | `demo` | `outbound`), `page_url`, `visitor_id`, `user_id`.
  - [x] Add `cost_cents` (from Retell `call_cost`), `started_at` and `ended_at`.
  - [x] Add indexes on `(website_id, created_at)` and `(widget_id, created_at)`.
- [x] **Log web calls:** `/api/call/create` inserts a `registered` row for every web call it creates.
- [x] **Retell webhook `POST /api/webhooks/retell`:**
  - [x] Verify the signature with `Retell.verify` and `RETELL_API_KEY`.
  - [x] Handle `call_started`, `call_ended` and `call_analyzed`: update status, duration, disconnection reason, transcript, summary and cost.
  - [x] Ignore events for calls we don't know about, and accept the same event twice without side effects.
  - [x] Set the webhook URL on the agent (`webhook_url`), automatically from `PUBLIC_APP_URL`.
  - [ ] Set it on the phone number too, when inbound calls are added (Phase 5).
- [x] **Remove polling:** keep `listCallLogs()` refreshing from Retell only as a fallback for calls the webhook missed.
- [x] **Usage function `va_usage_daily`:** minutes, calls and cost per day by source and widget, for dashboards and limits. It's a SQL function, not a view, so days are bucketed in the business's timezone.

**Deliverables:**
- Every call type appears in `va_call_logs`.
- Webhook endpoint with signature check.
- Daily usage view.

**Done when** (✅ verified 2026-10-29: cross-site widget calls with cost and the full funnel logged):
- A landing-page call and an outbound call both show final duration, summary and cost within 1 minute of hang-up, with no admin page open.

### 1B. Widget
- [x] **Migration `va_widgets`:**
  - [x] Columns: `id`, `website_id`, `public_key` (e.g. `wk_…`), `name`, `allowed_origins text[]`, `theme` (accent color, position, button label), `enabled`, `created_at`.
  - [x] RLS through `is_admin`.
- [x] **Embed page `/embed/[publicKey]`:**
  - [x] A dialer UI built to sit inside an iframe: compact, launcher button that expands into a panel.
  - [x] Header `Content-Security-Policy: frame-ancestors <allowed_origins>` per widget, so only allowed sites can embed it.
  - [x] Reuse `Dialer.tsx` logic (extract a `useRetellCall` hook shared by the landing page and the widget).
- [x] **Loader script `/widget.js`:**
  - [x] Reads `data-key`, creates an iframe with `allow="microphone"`, and handles open/close and resizing through `postMessage`.
  - [x] Under 5 KB, no dependencies, cacheable.
- [x] **Token endpoint `POST /api/widget/[publicKey]/call`:**
  - [x] Check that the widget is enabled.
  - [x] Check the parent origin against `allowed_origins`.
  - [x] Rate limit per IP and per widget.
  - [x] Call `createWebCall` with metadata `{ widget_id, page_url, visitor_id }`, then log the call.
- [x] **Anonymous visitor ID:** a random ID stored in the iframe's `localStorage`, used for "returning visitor" stats. No personal data.
- [x] **Widget events (light funnel):** `loaded`, `opened`, `call_started`, `call_ended` posted to `POST /api/widget/[publicKey]/event`, rate limited per IP, stored in `va_widget_events`.
- [x] **Admin → Widgets tab:**
  - [x] Create, rename and disable widgets.
  - [x] Edit allowed domains and theme, with a live preview.
  - [x] Copy the embed snippet.
- [x] **Admin → Analytics tab:**
  - [x] Calls, minutes and cost by day and by source/widget.
  - [x] Funnel: loaded → opened → call started.
  - [x] Average call length, top pages, recent calls with summaries.
- [x] **Test page:** `scripts/widget-test.html`, served on a second local origin, to prove cross-site embedding and that the CSP blocks other domains.

**Deliverables:**
- `/widget.js` and `/embed/[key]`.
- Widget admin with a copy-paste snippet.
- Analytics tab.

**Done when** (✅ verified 2026-10-29: cross-site widget calls with cost and the full funnel logged):
- Pasting the snippet into a page on another domain shows the widget, a call works with the mic, and the call appears in Analytics with its page URL.
- Embedding from a domain that isn't allowed is blocked.

---

## Phase 2 — Public demo (5 minutes per user)

**Goal:** Prospects can try the agent for free without running up our voice bill. A free account is required, which also gives us leads.

- [x] **Demo config:**
  - [x] Free time per user (default 5 minutes), daily budget in minutes (global kill switch), on/off, and a "Talk to us" link.
  - [x] Stored in a `va_demo_settings` row and edited in **Admin → Demo**, so no redeploy is needed.
- [x] **Allowance tracking:**
  - [x] Remaining seconds = 300 − sum of the user's `demo` call durations.
  - [x] Count an active call's elapsed time so the user can't run two tabs at once.
  - [x] Only one active demo call per user.
  - [x] Reservations happen in one locked database function (`va_demo_reserve`), so parallel tabs or requests can't overspend the user's time or the daily budget.
- [x] **`POST /api/demo/call`:**
  - [x] Requires login (`user` role is enough).
  - [x] Rejects the call if the allowance or the daily budget is used up.
  - [x] Sets `agent_override.agent.max_call_duration_ms` to the remaining seconds, so the call ends exactly when the allowance runs out.
- [x] **Demo page `/demo`:**
  - [x] Shows "4:12 of 5:00 left" and a countdown during the call.
  - [x] When the allowance is used up, shows a call to action (book a call or get pricing) instead of the dialer.
  - [x] Sample scenarios the visitor can pick (clinic, real estate, online store), plus "Our support agent" (the site's own agent).
  - [x] The scenarios run on a separate Retell demo agent, created automatically. Its prompt is a template filled per call with `retell_llm_dynamic_variables`, so the site's own agent is never changed.
- [x] **Abuse controls:**
  - [x] Keep the per-IP rate limit.
  - [x] Block disposable email domains at signup.
  - [ ] Optional: email verification before the first demo call (turn autoconfirm off for this site, or check `email_confirmed_at`).
- [x] **Lead capture:**
  - [x] Demo users are listed in **Admin → Leads**: email, name, minutes used, scenarios tried, signup date.
  - [x] Export to CSV.
- [x] **Landing page update:** a "Try it free for your business" button and a "Try the demo" link in the header. The landing dialer stays as the site's own support line.

**Deliverables:**
- `/demo` with a per-user 5-minute allowance.
- Daily budget kill switch.
- Leads list.

**Done when** (not yet verified; needs the migration plus real calls):
- A new user can talk for 5 minutes total across any number of calls, is cut off at 5:00, and can't start another call.
- The admin sees them in Leads.
- Demo spend never goes above the daily budget.

---

## Phase 3 — Workspaces (one account per customer business) 🧪 Live, isolation verified

**Goal:** Many businesses use the platform, each with their own agent, documents, widgets, numbers and usage. Inside Supabase, the "Voice Agent" website stays the tenant; workspaces are our customers inside it.

- [x] **Migration** (`20261101_voice_agent_workspaces.sql`):
  - [x] New tables `va_workspaces` (`name`, `slug`, `template`, `plan`, `status`, `trial_seconds`, `is_platform`), `va_workspace_members` (`owner` | `admin` | `member`) and `va_workspace_invites` (stores only a hash of the link token).
- [x] **Move to per-workspace ownership:**
  - [x] `workspace_id` on `va_agent_configs` (primary key is now `workspace_id`), `va_agent_documents`, `va_call_logs`, `va_widgets` and `va_widget_events`.
  - [x] A composite foreign key `(workspace_id, website_id)` means a row can never point at a workspace on another website.
  - [x] Existing data is backfilled into a **platform workspace** ("Voice Agent", owned by the website admins). It runs the landing dialer, the demo's "Our support agent" and outbound calls.
- [x] **RLS:** `va_workspace_role()` / `va_is_workspace_member()` read `auth.uid()` themselves, so they can't probe other users. Members can read their workspace's rows; there are no write policies, so every write goes through the server after a role check. Website admins (platform staff) see every workspace.
- [x] **Code refactor:**
  - [x] `authorizeWorkspace(slug, minimumRole)` replaces the single-agent `WEBSITE_ID` lookup. Non-members get 404, so slugs can't be probed.
  - [x] `agent-config`, `knowledge-base`, `widgets`, `call-logs`, `analytics`, `outbound` and `web-calls` all take the workspace.
  - [x] Webhooks and inbound calls are matched to a workspace by Retell agent ID.
  - [x] Knowledge base files are stored under `<website_id>/<workspace_id>/`, and the server refuses paths outside the caller's folder.
- [x] **Per-workspace Retell resources:**
  - [x] Each workspace gets its own Retell LLM, agent and knowledge base, created during onboarding (and retried on the Agent page if Retell fails).
  - [x] Retell names are prefixed with the slug (`acme-dental · Acme Receptionist`, `acme-dental KB`).
- [x] **Onboarding flow:**
  - [x] `/onboarding`: business name + template (customer support, clinic, real estate, online store, restaurant).
  - [x] The Agent page has a "Get your agent live" checklist: add business info → test call (built-in dialer) → create a widget → allow your site and paste the snippet.
- [x] **Team** (`/w/<slug>/team`):
  - [x] Invite by email with a copyable link: one use, 7 days, only for that email.
  - [x] Change roles, remove members, leave. A workspace always keeps at least one owner.
  - [x] Only owners can make owners; admins manage admins and members; members can view analytics and calls only.
- [x] **Platform console `/platform`** (website `admin` only):
  - [x] Every workspace with its owner, 30-day calls, minutes and cost, setup progress and trial usage.
  - [x] Set the status (trial / active / suspended) and the trial minutes.
  - [x] The demo settings moved to **Platform → Demo**.
- [x] **Cost guard until billing (Phase 6):**
  - [x] New workspaces start as `trial` with 10 minutes of talk time (test, widget and outbound calls combined); each call is capped to what's left.
  - [x] Suspended workspaces take no calls, and their widgets disappear.
  - [x] A person can own at most 3 workspaces.
- [x] **Outbound stays platform-only** until Phase 5. Every number in the Retell account is ours, so a customer workspace must not call out from it.
- [x] **Isolation tests:** `node scripts/isolation-test.mjs [appUrl]`:
  - [x] Creates two throwaway users and workspaces, and proves neither can read or change the other's agent, docs, files, calls, widgets or team through the API or directly through Supabase.
  - [x] Also checks the invite rules, role limits and trial guard, then cleans up.

**Deliverables:**
- Multi-workspace data model.
- Onboarding wizard.
- Team invites.
- Platform console.

**Done when:**
- [ ] Two test businesses each set up their own agent and widget end to end (in the browser).
- [x] The isolation script passes: 47/47 on 2026-10-30, test users and Retell agents cleaned up.

## Phase 4 — Agent training studio ✅ live and verified (except AI-suggested improvements)

**Goal:** Business owners and their team improve their own agent without writing prompts and without our help. They:
- teach it facts and answers,
- fix wrong answers from real calls,
- test changes before they go live.

The agent learns through its prompt and knowledge base, not by retraining the model. So every "training" action becomes:
- a knowledge base source (Retell text, URL or file sources),
- or a change to the prompt, saved as a new agent version.

### 4A. Teach: business knowledge without prompt writing ✅ Built
- [x] **Business profile form** (Agent → Profile):
  - [x] Fields: business name, what the agent does (template), what you do, services and prices, hours, location, policies, tone (friendly / formal / Taglish), topics to avoid, when to hand off.
  - [x] The prompt is assembled by `lib/prompt.ts`: platform rules + the profile, written into the template + team rules. A preview shows the full prompt.
  - [x] Raw prompt editing is the **Advanced** mode. Existing agents start in Advanced with their current prompt.
- [x] **Team rules:** short "always / never" rules added to the prompt (`va_agent_rules`).
- [x] **FAQ editor** (Agent → Knowledge):
  - [x] Question → answer, plus other ways people ask it. Each FAQ is one Retell `knowledge_base_texts` source, matched by a `[faq:<id>]` tag in its title.
  - [x] Stored in `va_agent_faqs` (`origin`: `manual` | `correction` | `unanswered`).
  - [x] Editing adds the new source, then deletes the old one.
- [x] **Website import:**
  - [x] Pages are added as `knowledge_base_urls`, with a Refresh button (re-import).
  - [x] New knowledge bases are created with `enable_auto_refresh`. Retell can't turn auto-refresh on for an existing knowledge base.
- [x] **Documents:** the existing upload, now on the Knowledge page.
- [ ] Per-plan limits for documents, FAQs and pages (Phase 6). Fixed caps for now: 200 FAQs, 25 pages, 50 rules.

### 4B. Test: try changes before callers hear them ✅ Built
- [x] **Draft vs live** (verified against the Retell API):
  - [x] Publishing agent version N also publishes its LLM version, and published versions are read-only. After each publish we open a new draft with `agent.createVersion`.
  - [x] Calls that don't name a version get the newest one, drafts included. So landing, widget, demo and outbound calls are pinned to `va_agent_configs.live_version`, and only test calls use the draft.
  - [x] The first time a workspace opens the studio, today's version is published as the live one.
  - [x] **The knowledge base isn't versioned:** FAQs, pages and files apply to live calls at once. A brand-new knowledge base is attached to the draft and goes live on Publish.
  - [x] The publish bar shows unpublished changes, warns about missing, failed or stale test runs, and takes a note.
- [x] **Text playground:** chat with the draft or the live version (`playground.completion`). No voice minutes.
  - [ ] Show which knowledge base snippets were used: Retell's playground doesn't return them.
- [x] **Voice test call** on the draft (`source = 'test'`, kept out of analytics, counted against trial minutes).
- [x] **Agents can hang up:** every workspace LLM gets an `end_call` tool, and the platform rules say to end the call after a goodbye. Without it Retell's test simulations stopped as loops, and only callers could end calls.
- [x] **Test cases:** caller + expected behavior, saved as Retell test definitions and run as a batch against the draft LLM version, with pass/fail and the reason per case. Failing or stale runs warn at publish; there's no blocking setting yet.
- [x] **Version history:** `va_agent_changes` logs edits (draft or knowledge), publishes and rollbacks, with who did it. Each publish stores a snapshot.
  - [x] **Make live again** creates a new version from the old one, publishes it, and restores the studio settings and rules from the snapshot. Unpublished draft edits are discarded; knowledge stays as it is.

### 4C. Improve: learn from real calls ✅ Built and verified (except AI suggestions)
- [x] **Post-call analysis fields** on every workspace agent (`post_call_analysis_data`, `lib/call-analysis.ts`):
  - [x] `resolved` (boolean)
  - [x] `unanswered_questions` (string, one question per line)
  - [x] `caller_intent` (enum: information, pricing, booking, existing order or account, complaint, sales, other)
  - [x] Sentiment uses Retell's built-in `user_sentiment`, which was already saved.
  - [x] Saved to `va_call_logs` (`resolved`, `caller_intent`, `analysis`) by the Phase 1 webhook.
  - [x] Published versions can't be edited, so live web and outbound calls get the fields as a per-call override. New agents and every draft save also set them, so inbound phone calls get them after the next publish.
- [x] **Unanswered questions inbox** (Agent → Improve):
  - [x] Questions the agent couldn't answer (`va_agent_questions`), grouped by shared keywords and sorted by how often they're asked. Test and demo calls are left out.
  - [x] **Add answer** turns a group into an FAQ entry (origin `unanswered`), with the callers' other wordings as alternates. It can also be answered with a rule. **Ignore** dismisses it.
- [x] **Review and correct from a transcript:**
  - [x] In the review queue, any agent reply can be marked **Wrong answer**. The owner types the correct answer.
  - [x] Choose how to fix it:
    - [x] add as a FAQ entry (a fact the agent didn't know). Live once indexed, because the knowledge base isn't versioned;
    - [x] add as a rule in the prompt (a behavior to change). It's a draft edit, live after Publish.
  - [x] Saved in `va_agent_corrections`: call, transcript position, what the caller said, original reply, fix, fix type, status.
- [x] **Caller feedback:** a 👍 / 👎 prompt in the widget after a connected call, with an optional comment. A call can be rated once, within an hour, and only through the widget that started it. Calls rated 👎 come first in the review queue, then unresolved calls, calls with unanswered questions, and unhappy callers. **Mark reviewed** clears a call from the queue.
- [ ] **Suggested improvements (AI-assisted):** not built. It needs an LLM API key and a scheduled job (e.g. Vercel Cron).
  - [ ] A weekly job reads unresolved calls and corrections, and drafts suggested FAQ answers and prompt rules.
  - [ ] Suggestions are never applied automatically. The owner approves each one, and it goes into the draft.
- [x] **Quality dashboard:** resolved rate, unanswered rate, 👍 share and average call length per day (one measure at a time), with publish and rollback days marked on the chart. Also: caller intents, and the resolved rate before vs. after the latest publish.

### 4D. Permissions and guardrails ✅ Built (except plan limits)
- [x] **Roles:**
  - [x] Members can use the playground, make test calls, and see test results and history.
  - [x] Only owners and admins can edit, publish or roll back.
  - [x] Members can flag wrong answers and suggest answers for inbox questions. Their fixes wait for an owner or admin to apply or dismiss them.
- [ ] **Limits per plan** (Phase 6).
- [x] **Safety checks before publish:** publishing is blocked when the profile, Advanced prompt, greeting or rules tell the agent to collect card numbers, passwords or one-time codes, to pretend to be a human, or to hide that it's an AI. Negated lines ("never ask for card numbers") are fine.
- [x] **Platform rules** (AI disclosure, no secrets, no professional advice, emergencies) are always added at the top of the prompt. Workspaces can't edit them.

**Deliverables:**
- A training studio with Teach, Test, Improve and History tabs.
- Draft/publish with rollback.
- Unanswered-questions inbox and transcript corrections.
- Quality dashboard.

**Done when** (checked on 2026-10-30 by `node scripts/studio-test.mjs`, 27/27, and `node scripts/improve-test.mjs`, 41/41; the improve test sends call analysis through the signed webhook, so a real analyzed call is still worth checking by hand):
- A business owner with no prompt-writing experience:
  - fills in the profile form;
  - adds 5 FAQ entries;
  - tests the agent in the playground;
  - publishes it.
- After a real call, they fix one wrong answer from the transcript, run the test cases and publish again.
- The next caller who asks the same question gets the corrected answer.
- Rolling back restores the previous behavior.

---

## Phase 5 — Phone numbers: choose, buy or bring your own

**Goal:** Each workspace gets a phone number for inbound and outbound calls without touching Twilio or Retell itself.

**Before starting:** upgrade the Twilio account from trial. Trial accounts can only call verified numbers, and SMS verification is blocked for PH numbers.

- [x] **Migration `va_phone_numbers`** (`20261104_voice_agent_phone_numbers.sql`):
  - [x] Columns: `workspace_id`, `e164`, `provider` (`retell` | `twilio` | `byo`), `provider_sid`, `country`, `nickname`, `inbound_enabled`, `outbound_enabled`, `outbound_countries`, `monthly_price_cents`, `status`, `purchased_at`, `released_at`.
  - [x] One active row per number across all workspaces. The platform's `+15677575800` is backfilled.
- [x] **Option A, buy a US/CA number through Retell:**
  - [x] `retell.phoneNumber.create({ country_code, area_code })`, bound to the workspace agent. $2/month, billed to our Retell account.
  - [x] Retell has no number search: it picks one, optionally in an area code. These numbers call the US and Canada only.
- [x] **Option B, buy through our Twilio account** (built; off until `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are set):
  - [x] Search available numbers (`AvailablePhoneNumbers`: local, else mobile), with the monthly price from Twilio's Pricing API.
  - [x] Buy the number (`IncomingPhoneNumbers`).
  - [x] Attach it to our Elastic SIP trunk.
  - [x] Import it into Retell (`phoneNumber.import`) with our trunk credentials. If any step fails, the number is released again.
  - [x] Calls PH, US and CA.
  - [ ] Not tested against Twilio yet (no API credentials). PH and some other countries need Twilio regulatory documents first.
- [x] **Option C, bring your own number:** the customer's number, SIP termination host and credentials are imported into Retell. The credentials aren't stored at all; to change them, release and import again. The page shows the inbound address to set on their trunk (`sip:sip.retellai.com;transport=tcp`).
- [x] **Number picker UI** (workspace → Phone numbers):
  - [x] Retell: country, optional area code, price and a confirm-purchase step. Twilio: country and area code search, a list with monthly prices, then confirm.
  - [x] The workspace's numbers, with switches for answering incoming calls and making outbound calls.
- [x] **Inbound calls:** `inbound_agents` with `agent_version: 'latest_published'`, so callers reach the published agent and never a draft. Inbound calls are logged by the webhook (Phase 1). Locally, recent inbound calls are read from Retell instead.
- [x] **Outbound:** the caller ID must be one of the workspace's numbers with outbound on. The destination country must be one the number may call. Any workspace with a number can call out; the platform-only rule is gone.
- [x] **Release a number:** delete it from Retell, release it in Twilio (our numbers), mark the row `released` and clear it as the caller ID. Owners only; safe to retry.
- [x] **Guardrails:**
  - [x] At most 3 numbers per workspace until plans exist (Phase 6).
  - [x] Until billing (Phase 6), only website admins can buy. Workspace admins can bring their own number.

**Deliverables:**
- Number search and purchase.
- BYO import.
- Inbound routing.
- Release flow.

**Done when** (`node scripts/numbers-test.mjs` 34/34 on 2026-10-30 using imported numbers: Retell refused the purchase with 402 "requires a card on file", so buying and a real phone call are still to check):
- A workspace buys a US number in the UI, a test phone calls it and reaches that workspace's agent, the workspace places an outbound call from it, then releases it, all without opening the Twilio or Retell dashboards.

---

## Phase 6 — Plans, billing and usage limits

**Goal:** Turn usage into revenue while protecting our margin.

- [x] **Cost model:**
  - [x] Measured: web calls cost about $0.14–0.16/min (₱8–9) from the first 5 calls. Outbound has no data yet; recheck once there's real traffic.
  - [x] Prices at roughly 2.5–3× cost, in USD: Starter $39 (100 min), Growth $99 (300 min), Business $249 (800 min). Phone numbers we provide are $3/month each. PayMongo charges the peso amount at the day's rate; visitors from the Philippines also see ≈ ₱ prices.
- [x] **Plans table `va_plans`:**
  - [x] Fields: included minutes, overage price per minute (stored, not charged: calls stop at the limit), max widgets, numbers, documents, FAQ entries and pages, AI suggestions on/off, outbound allowed.
  - [x] Starter / Growth / Business seeded. Outbound comes with Growth and Business. Trial: 1 widget, 1 number, 5 documents, 20 FAQs, 3 pages, no outbound.
  - [ ] One-off setup fee for done-for-you setups.
- [x] **Payments:**
  - [x] PayMongo Checkout: GCash, Maya, GrabPay, QR Ph and cards. Prepaid one month at a time; PayMongo's Subscriptions API needs account approval and doesn't take GCash.
  - [ ] Stripe for international customers (optional).
- [x] **Subscription lifecycle:**
  - [x] Trial → active (a paid month covers today) → expired (the month ended unpaid: calls stop) → suspended (by us).
  - [x] A renewal paid early starts when the current month ends; a new plan starts today.
  - [x] The PayMongo webhook settles payments (re-reading the checkout from PayMongo), and so does returning to the Billing page.
  - [x] Platform staff can grant a free month (e.g. for a bank transfer).
- [x] **Usage enforcement:**
  - [x] Every call token endpoint (landing, widget, test, outbound) checks the minutes left this month or in the trial.
  - [x] Each call's `max_call_duration_ms` is capped to what's left.
  - [ ] Inbound phone calls can't be refused yet (they count toward the minutes). Needs Retell's inbound webhook.
  - [x] Warnings at 80% and 100% of the minutes, and 5 days before an unpaid month ends: banners in the workspace.
  - [ ] Emails for those warnings (no email service yet).
- [x] **Number fees:** each number we provide adds ₱120 to every payment. Customers' own numbers are free.
- [x] **Billing page** (owners): current plan, minutes used this month, plans with checkout, payments with "Pay now" for unfinished ones. There's no saved payment method: each month is paid at checkout.
- [x] **Platform revenue view:** monthly recurring revenue, revenue against cost (Retell calls + our numbers, at `USD_TO_PHP`) per workspace, worst margin first, losses flagged. Twilio call charges aren't included yet.

**Deliverables:**
- Plans and checkout.
- Enforced minute allowances.
- Billing page.
- Margin report.

**Done when:**
- A workspace pays through PayMongo, gets its plan's minutes, is blocked at the limit (or billed overage), and the margin report shows revenue against Retell and Twilio cost.

---

## Phase 7 — Agent actions (the reason to pay more than an FAQ bot): booking modules built

**Goal:** The agent can *do* things during a call, not only answer questions.

- [x] **Tools framework:**
  - [x] Retell custom functions point to `POST /api/agent-tools` (one endpoint, dispatched by function name).
  - [x] Every request is verified with Retell's signature. The workspace comes from the calling agent's ID, never from the arguments, so one business's agent can't touch another's data.
  - [ ] Log each function call.
- [ ] **Caller context:**
  - [ ] Pass known customer data as `retell_llm_dynamic_variables` at call start: logged-in user for the widget, CRM record for outbound.
  - [ ] An inbound webhook that looks up the caller by phone number.
- [x] **Booking modules** (Agent → Bookings, offered at onboarding with sample data):
  - [x] **Reservations:** services (duration, price), weekly opening hours, slot length, how many at the same time. Functions `get_services`, `check_availability` (suggests the next open days when a day is full) and `book_appointment`. Booked under a lock (`va_book_appointment`), so two callers can't take the last spot.
  - [x] **Short-term rentals:** apartments (price per night, address, guests, bedrooms, amenities, house rules), check-in and check-out times. Functions `get_apartments`, `check_stay_availability` (with totals) and `book_stay`. A database exclusion constraint stops overlapping stays.
  - [x] Built-in calendar: upcoming bookings by day, added by the agent or by the team; cancel; services and apartments with bookings are hidden instead of deleted.
  - [x] The prompt gets today's date and a 14-day calendar in the business's time zone (Retell's `{{current_time_<tz>}}` and `{{current_calendar_<tz>}}`).
  - [x] New "Short-term rental" template.
  - [ ] Confirmation SMS or email to the customer.
  - [ ] Google Calendar or Cal.com sync.
- [ ] **Data lookup:** a configurable HTTPS lookup, e.g. order status by order number, with responses kept within a size limit and personal data filtered out.
- [ ] **Transfer to a human:** Retell transfer-call to a workspace number during business hours, otherwise a callback request.
- [ ] **Post-call actions:** send the summary to email, Slack or a webhook. Structured fields extracted with `post_call_analysis_data` (e.g. lead score, intent).
- [ ] **Outbound campaigns:**
  - [ ] Upload a CSV of contacts with consent.
  - [ ] Schedule calls within calling hours.
  - [ ] Retry on no answer.
  - [ ] Campaign report.
- [ ] **Industry templates:** clinic, real estate, e-commerce, collections. Each has a prompt, greeting, tools and post-call fields.

**Deliverables:**
- Booking, lookup, transfer and campaigns.
- Templates.

**Done when:**
- A test caller books a real appointment through the agent, it appears in the calendar, and the summary arrives in Slack or email.

---

## Phase 8 — Launch hardening and compliance

- [ ] **Distributed rate limiting:** replace the in-memory limiter with Upstash Redis or a Supabase table. Vercel runs many instances, so the in-memory counts aren't shared.
- [ ] **Monitoring:** error tracking (Sentry), webhook failure alerts, a daily spend alert per workspace and for the platform.
- [ ] **Data protection (PH Data Privacy Act / GDPR basics):**
  - [ ] Privacy policy and terms.
  - [ ] Call recording and AI disclosure in the greeting.
  - [ ] Transcript retention setting with automatic deletion.
  - [ ] Data export and delete per workspace.
- [ ] **Outbound compliance:**
  - [ ] Store proof of consent.
  - [ ] Do-not-call list per workspace.
  - [ ] Calling-hours window by the recipient's timezone.
  - [ ] TCPA rules for US numbers.
- [ ] **Security review:** RLS audit, secrets rotation, widget key rotation, webhook replay protection.
- [ ] **Load test:** concurrent widget calls against Retell concurrency limits, and how the widget handles a "line busy" response.
- [ ] **Marketing site:** pricing page, demo call to action, case study from the first pilot customers.
- [ ] **Docs:** install guide for the widget (WordPress, Shopify, plain HTML), number setup, FAQ.

**Deliverables:**
- A product that is ready to launch, with monitoring, legal pages and docs.

**Done when:**
- Three paying pilot customers are live with no manual work from us after onboarding.

---

## Decisions and open questions

| Topic | Decision / question |
| :--- | :--- |
| Demo access | **Decided:** a free account is required (lead capture). 5 minutes total per user, not per day. *Open:* reset monthly? *Open:* the landing-page dialer is still anonymous (5 calls per IP per 10 minutes). Keep it as the site's own support line, or put it behind the demo allowance? |
| Widget isolation | **Decided:** iframe + `frame-ancestors` CSP per widget. The script only injects the iframe. No Retell code or keys on customer sites. |
| Call data source | **Decided:** the Retell webhook is the source of truth, with polling as a fallback. |
| Agent training | **Decided:** training only changes the prompt and knowledge base, never retrains the model. Every change goes through draft → test → publish, with rollback. AI suggestions need the owner's approval. *Open:* let end callers' 👎 feedback reach the owner in real time, or only in the weekly review? |
| Number provider | **Recommended:** Retell-bought numbers for US/CA (simple), our Twilio account for PH (needed for PH outbound). *Open:* do customers want local PH numbers? This needs Twilio regulatory documents. |
| Billing currency | *Open:* PHP-only via PayMongo first, or USD via Stripe too? |
| Pricing | *Open:* set after 2–4 weeks of real cost data from Phase 1. |
| Workspace trials | **Decided (until Phase 6):** 10 free minutes per new workspace, activated by hand in `/platform`. Up to 3 owned workspaces per person. *Open:* auto-activate on payment once billing exists. |
| Invites | **Decided:** copyable links (no email service yet). *Open:* send invite emails once transactional email is set up (needs a provider; the Supabase project's auth emails are shared with other sites). |
