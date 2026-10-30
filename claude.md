# Voice Agent Support Portal — MVP Roadmap & Technical Spec

A streamlined, production-ready roadmap for building a customer support voice agent landing page and admin configuration portal using **Next.js (App Router)**, **Supabase**, **Tailwind CSS**, and **Retell AI**.

---

## 1. System Architecture & Tech Stack

To keep the MVP simple without sacrificing security or maintainability, we avoid building a custom RAG/vector pipeline from scratch. Instead, we use **Supabase** as the source of truth for auth, file storage, and config state, and sync directly with **Retell AI's native Knowledge Base and LLM APIs**.

| Layer | Technology | Role in MVP |
| :--- | :--- | :--- |
| **Frontend** | Next.js (App Router), Tailwind CSS, Lucide Icons | Visitor dialer UI, per-workspace dashboards (`/w/<slug>`) and the `/platform` console |
| **Voice Client** | `retell-client-js-sdk` | Handles browser WebRTC audio stream, mic controls, and live transcripts |
| **Backend API** | Next.js Route Handlers + `retell-sdk` | Issues call tokens, updates agent/LLM settings, and syncs Knowledge Base files |
| **Auth** | Supabase Auth | Protects admin routes and API endpoints via email/password login |
| **Database** | Supabase PostgreSQL | Stores agent settings (`va_agent_configs`) and uploaded document metadata (`va_agent_documents`) |
| **File Storage** | Supabase Storage | Stores raw uploaded documents (`.pdf`, `.txt`, `.docx`, `.md`) before syncing to Retell |

---

## 2. Core Workflows

### A. Visitor Call Workflow (Public)
1. **Visitor lands on `/`:** Sees the support landing page and the phone dialer card.
2. **Clicks "Start Call":** Browser requests microphone permissions.
3. **Token Request:** Frontend calls `POST /api/call/create`.
4. **Server Registration:** Next.js backend calls `retell.call.createWebCall({ agent_id })` using the secret API key and returns a single-use `access_token`.
5. **WebRTC Connection:** Frontend passes `access_token` to `retellWebClient.startCall({ accessToken })`.
6. **Live Conversation:** Audio streams bi-directionally; live transcript updates render in the dialer UI.
7. **Call Ends:** Visitor clicks hang up (or agent ends call), returning the dialer to the idle state.

### B. Admin Agent Configuration Workflow (Protected)
1. **Admin logs in at `/login`:** Authenticated via Supabase Auth.
2. **Opens `/w/<slug>` (Agent tab):** Fetches the workspace's agent configuration from Supabase (`va_agent_configs` table).
3. **Updates Settings:** Admin edits Agent Name, Voice ID, Voice Speed, Opening Greeting (`begin_message`), or System Prompt (`general_prompt`) and clicks **Save**.
4. **Dual Sync:** Backend `PATCH /api/w/<slug>/agent` updates both Retell (`retell.agent.update` & `retell.llm.update`) and the Supabase `va_agent_configs` row.

### C. Admin Document Upload / Knowledge Base Workflow (Protected)
1. **Admin uploads files on the workspace's Agent tab:** Selects one or more files (`.pdf`, `.txt`, `.docx`, `.md`).
2. **Supabase Upload:** File is uploaded to the `knowledge-docs` Supabase Storage bucket.
3. **Retell Knowledge Base Sync:**
   - Backend checks if a `retell_kb_id` exists in `va_agent_configs`.
   - If not, it creates a new Retell Knowledge Base (`retell.knowledgeBase.create`) and attaches its ID to the Retell LLM (`knowledge_base_ids: [kb_id]`).
   - If it exists, it appends the newly uploaded file to the existing Knowledge Base (`retell.knowledgeBase.addSources`).
4. **Metadata Logged:** File metadata (name, size, storage path, Retell source ID, status) is saved in the Supabase `va_agent_documents` table so the admin can view or delete documents later.

---

## 3. Business Logic Rules

1. **One Agent per Workspace:**
   - Each customer business is a workspace (`va_workspaces`) inside the Voice Agent website. `va_agent_configs` has one row per workspace (`workspace_id` primary key), mapped to one Retell `agent_id`, one `llm_id`, and one `knowledge_base_id`.
   - The **platform workspace** (`is_platform`, slug `voice-agent`, owned by website admins) runs this site's own agent: the landing dialer, the demo's "Our support agent", and outbound calls.
2. **Knowledge Base Constraints:**
   - **Allowed File Types:** `.pdf`, `.txt`, `.md`, `.docx` (enforced on both client input and server route).
   - **Max File Size:** 10 MB per file (prevents Next.js body size timeouts and keeps Retell indexing fast).
   - **Deletion Logic:** When an admin deletes a document in the UI, the backend removes the source from Retell's Knowledge Base first, then deletes the file from Supabase Storage and the row from `va_agent_documents`.
3. **Call Cost & Duration Guardrails:**
   - Every web call is configured with `max_call_duration_ms: 300000` (5 minutes) on the Retell agent to prevent visitors from leaving a tab open and draining credits.
   - If the visitor navigates away or closes the tab (`window.beforeunload`), `retellWebClient.stopCall()` triggers automatically.

---

## 4. Security Architecture

Keeping security simple and strict for the MVP:

1. **No Public Retell Keys in the Browser:**
   - Do not expose Retell API keys in `NEXT_PUBLIC_*` variables. All interactions with Retell go through Next.js server routes. The browser only ever receives a temporary `access_token` generated by `retell.call.createWebCall()`.
2. **Supabase Middleware Protection:**
   - The proxy (`src/proxy.ts` → `lib/supabase/proxy.ts`) requires a session for `/dashboard`, `/onboarding`, `/w/*`, `/api/w/*`, `/api/workspaces` and `/api/invites/*`, and the website `admin` role for `/platform/*` and `/api/platform/*`. Unauthenticated requests get `401 Unauthorized` or a redirect to `/login`. Old `/admin` URLs redirect to `/dashboard`.
   - **Multitenant isolation:** The Supabase project is shared across several websites; every tenant is a row in `websites`, identified by `WEBSITE_ID` (Voice Agent = `c8b2b438-d3d9-4ec9-8493-768a2476241f`). Supabase Auth accounts are global, so "logged in" is **not** enough:
     - **Login (`/login`):** after `signInWithPassword`, call `rpc('has_website_access', { p_website_id: WEBSITE_ID, p_user_id })`. If `false`, `signOut()` immediately and redirect to `/signup?email=...` — users from other websites cannot log in until they sign up for Voice Agent.
     - **Signup (`/signup`):** new users call `signUp`; existing accounts from other websites must re-enter their password (`signInWithPassword`). Then enroll via `rpc('register_website_user', { p_website_id: WEBSITE_ID, p_full_name })`, which grants the `user` role to `auth.uid()` only.
     - **Website roles (`website_roles`):** `admin` (platform staff: `/platform`, owner access to every workspace) and `user` (self-registered). Admin is granted only server-side with the service role via `enroll_user_in_website` — never from the browser.
     - **Workspace roles (`va_workspace_members`):** `owner` (everything, including making owners), `admin` (agent, documents, widgets, calls, team) and `member` (analytics and calls). A workspace always keeps at least one owner.
     - **Guards:** every `/api/w/[slug]/*` handler calls `workspaceRoute(params, minimumRole)` (`lib/route-auth.ts` → `authorizeWorkspace`). Non-members get `404` (slugs can't be probed); a role below the minimum gets `403`. `/api/platform/*` handlers call `authorizeAdmin()`.
3. **Row Level Security (RLS):**
   - Every `va_` table has RLS enabled. Workspace data is readable by that workspace's members (`va_is_workspace_member(workspace_id)`, which reads `auth.uid()` itself). There are no write policies: all writes go through the server with the service role after a role check.
   - The server's service-role queries bypass RLS, so every query filters by `website_id` **and** `workspace_id`. A composite foreign key `(workspace_id, website_id)` stops a row from pointing at another website's workspace.
   - `knowledge-docs` Storage bucket is set to **Private**. Only the service role reads and writes files; the browser uploads through short-lived signed upload URLs.
4. **Public Call Endpoint Rate Limiting:**
   - Protect `POST /api/call/create` with a lightweight in-memory IP rate limiter (e.g., max 5 call starts per IP per 10 minutes) to prevent bot abuse of voice minutes.

---

## 5. Technical Architecture & Code Reference

### A. Directory Structure
```text
src/
├── proxy.ts                        # Next.js 16 proxy (formerly middleware): session refresh, admin guard, embed CSP
├── app/
│   ├── page.tsx                    # Public landing page + voice dialer UI
│   ├── login/page.tsx              # Login (signs out accounts not enrolled in WEBSITE_ID)
│   ├── signup/page.tsx             # Signup (enrolls into WEBSITE_ID with role "user")
│   ├── auth/actions.ts             # Server actions: login, signup, logout
│   ├── dashboard/page.tsx          # The user's workspaces (redirects to /onboarding if none)
│   ├── onboarding/page.tsx         # New workspace: business name + template
│   ├── invite/[token]/page.tsx     # Accept a team invite (must be signed in with the invited email)
│   ├── w/[slug]/                   # One workspace, tabbed via w/[slug]/layout.tsx (role-aware tabs, trial banner)
│   │   ├── (agent)/                # Agent training studio: sub-nav + publish bar (layout.tsx)
│   │   │   ├── page.tsx            # Profile: checklist, business profile / Advanced prompt, voice & greeting, rules
│   │   │   ├── knowledge/page.tsx  # FAQs, web pages, documents (live immediately)
│   │   │   ├── modules/page.tsx    # Modules setup: turn on reservations/rentals, services, hours, apartments
│   │   │   ├── test/page.tsx       # Text playground (draft/live), draft test call, test cases
│   │   │   ├── improve/page.tsx    # Call quality chart, unanswered questions, review calls, fixes
│   │   │   └── history/page.tsx    # Edits, publishes, rollbacks; "Make live again"
│   │   ├── bookings/page.tsx       # Live reservations (tab shown only when a module is on): stats, week calendar, nights booked, upcoming, what you offer
│   │   ├── widgets/page.tsx        # Widgets: embed code, allowed sites, theme, live preview
│   │   ├── analytics/page.tsx      # Analytics: calls/minutes/cost, widget funnel, recent calls
│   │   ├── numbers/page.tsx        # Phone numbers: buy (Retell / Twilio), bring your own SIP, inbound/outbound switches, release
│   │   ├── outbound/page.tsx       # Outbound calls from the workspace's own numbers (Growth and Business)
│   │   ├── billing/page.tsx        # Owners: plan, minutes this month, plans + PayMongo checkout, payments
│   │   └── team/page.tsx           # Members, roles, invite links
│   ├── platform/                   # Website admins only
│   │   ├── page.tsx                # Every workspace: usage, cost, status and trial minutes
│   │   ├── revenue/page.tsx        # MRR, revenue vs Retell + number cost per workspace, negative margins
│   │   └── demo/page.tsx           # Demo settings, today's budget, leads + CSV export
│   ├── embed/[key]/page.tsx        # Widget UI rendered inside the iframe on customer sites
│   ├── demo/page.tsx               # Public demo: sign-up gate, scenarios, free-time countdown
│   └── api/
│       ├── call/create/route.ts    # Public POST: Retell web call access_token (rate limited)
│       ├── widget/[key]/call/route.ts  # Public POST: widget call token (allowed sites + rate limits)
│       ├── widget/[key]/event/route.ts # Public POST: widget funnel events
│       ├── widget/[key]/feedback/route.ts # Public POST: caller 👍/👎 on a call this widget started
│       ├── webhooks/retell/route.ts    # Retell call events (signature-verified) -> va_call_logs
│       ├── webhooks/paymongo/route.ts  # PayMongo checkout paid (signature-verified, re-read from PayMongo)
│       ├── agent-tools/route.ts    # Retell custom functions for booking modules (signature-verified; workspace from the agent)
│       ├── demo/status/route.ts    # Member GET: remaining free demo time
│       ├── demo/call/route.ts      # Member POST: reserve time + start a demo call
│       ├── workspaces/route.ts     # Member GET mine / POST create (+ provisions the Retell agent)
│       ├── invites/accept/route.ts # Member POST: join a workspace with an invite token
│       ├── platform/               # Website admin: workspaces/[id] PATCH (status, trial), demo PATCH
│       └── w/[slug]/               # Workspace API (role checked per handler)
│           ├── agent/route.ts      # Admin GET/PATCH: syncs agent & LLM settings
│           ├── docs/route.ts       # Admin GET/POST/DELETE: KB documents
│           ├── docs/upload-url/route.ts # Admin POST: signed Storage upload URL
│           ├── calls/route.ts      # Member GET (?source=&limit=) / admin POST outbound call
│           ├── outbound/route.ts   # Admin PATCH: caller ID + outbound greeting
│           ├── billing/route.ts    # Owner POST: PayMongo checkout for one month of a plan
│           ├── modules/ services/ rentals/ bookings/  # Booking modules: settings, items, calendar
│           ├── numbers/            # Admin GET / POST (buy: website admins; BYO: admins), search (Twilio), [id] PATCH switches, DELETE release (owner)
│           ├── test-call/route.ts  # Member POST: browser test call on the draft (source "test")
│           ├── profile/ rules/ faqs/ pages/   # Studio: draft prompt inputs and knowledge
│           ├── playground/route.ts # Member POST: text reply from the draft or live version
│           ├── tests/ tests/run/   # Test cases (Retell test definitions) and batch runs
│           ├── publish/route.ts    # Admin POST: publish the draft (safety-checked)
│           ├── history/route.ts    # Member GET changes / admin POST rollback
│           ├── improve/            # questions (member GET, admin ignore), corrections (member POST, admin apply/dismiss), calls (review queue)
│           ├── members/route.ts    # Member GET, admin PATCH role, DELETE (anyone can leave)
│           ├── invites/route.ts    # Admin GET/POST/DELETE invite links
│           └── widgets/            # Admin widget CRUD
├── components/                     # Dialer, SiteHeader, auth forms, admin panels, widget/WidgetApp
│   ├── workspace/                  # WorkspaceContext (slug, role → API base), nav, onboarding, team
│   ├── studio/                     # Training studio: publish bar, profile, rules, FAQs, pages, playground, tests, history
│   ├── platform/                   # Platform console
│   └── call/useRetellCall.ts       # Shared browser call hook (landing dialer + widget)
public/widget.js                    # Loader customers paste on their site: injects + sizes the iframe
scripts/widget-test.html            # Cross-site widget test page (serve on another port)
scripts/isolation-test.mjs          # Workspace isolation test: two users, API + direct Supabase, then cleanup
scripts/studio-test.mjs             # Studio test: profile, FAQ, draft vs live, test case, publish, pinning, rollback
scripts/improve-test.mjs            # Improve test: signed analysis webhooks, inbox, feedback, review queue, fixes, publish
scripts/modules-test.mjs            # Modules test: onboarding with samples, signed agent-function calls, availability, double booking, stays, isolation
scripts/billing-test.mjs            # Billing test: trial limits, PayMongo test-mode payments (Playwright), renewal, upgrade, minute and month limits, grants, revenue
scripts/paymongo-webhook.mjs        # One-time: registers the PayMongo webhook and prints PAYMONGO_WEBHOOK_SECRET
scripts/numbers-test.mjs            # Numbers test: buys and releases one real Retell number (~$2), BYO imports, switches, caller ID
scripts/lib/harness.mjs             # Shared helpers for those scripts (throwaway users, cleanup)
└── lib/
    ├── supabase/{client,server,proxy}.ts
    ├── auth.ts                     # has_website_access / is_admin, authorizeAdmin(), authorizeWorkspace(slug, role)
    ├── route-auth.ts               # workspaceRoute(): auth for /api/w/[slug] handlers
    ├── workspaces.ts               # Workspaces: create (capped), platform workspace, trial call guard, console
    ├── workspace-roles.ts          # Shared role rules (who can assign / manage whom)
    ├── team.ts                     # Members, invites (hashed tokens), role changes, last-owner guard
    ├── templates.ts                # Industry templates: agent name, greeting, the "your job" prompt section
    ├── prompt.ts                   # Prompt builder (platform rules + profile/Advanced + team rules), safety check
    ├── agent-draft.ts              # Retell versioning: draft, publish, rollback, rules, change log
    ├── faqs.ts                     # FAQ entries as knowledge base text sources
    ├── agent-tests.ts              # Test cases (Retell simulations), runs, text playground
    ├── call-analysis.ts            # Post-call analysis fields, intents, transcript/question parsing (shared)
    ├── improve.ts                  # Unanswered-question inbox, corrections, review queue, caller feedback, quality
    ├── agent-config.ts             # Per-workspace config: provision from template (or RETELL_AGENT_ID for the platform), sync to Retell, webhook URL
    ├── call-logs.ts                # va_call_logs: insert, apply Retell snapshots, list with fallback refresh
    ├── web-calls.ts                # createWebCall + log (landing, widget, later demo)
    ├── widgets.ts / widget-config.ts / widget-request.ts # Widget data, origin rules, request checks
    ├── analytics.ts                # Usage by day/source, widget funnel, top pages
    ├── outbound.ts                 # Outbound phone calls (caller ID must be one of the workspace's numbers)
    ├── phone-numbers.ts            # va_phone_numbers: buy via Retell/Twilio, BYO SIP import, inbound binding, release
    ├── twilio.ts                   # Twilio REST (fetch): search, buy, attach to our SIP trunk, release
    ├── billing.ts                  # Plans, limits, call caps, PayMongo checkout + settlement, grants, revenue report
    ├── paymongo.ts                 # PayMongo Checkout Sessions + webhook signature
    ├── fx.ts                       # Live USD→PHP rate (cached 12h), visitor country from the host's IP header
    ├── money.ts                    # formatUsd / formatPhp / formatPrice (shared)
    ├── modules-shared.ts           # Module types, defaults, sample data, time-zone helpers (shared)
    ├── modules-agent.ts            # Module prompt section + Retell custom function definitions
    ├── bookings.ts                 # Services, apartments, availability, booking, agent-function handlers
    ├── public-url.ts               # PUBLIC_APP_URL if it's public https (webhooks, agent functions)
    ├── demo.ts / demo-config.ts    # Demo agent + scenario prompts, reservations, leads
    ├── knowledge-base.ts           # Upload -> Retell KB sync, source-id reconciliation, delete
    ├── retell.ts                   # Singleton Retell SDK instance
    ├── rate-limit.ts               # In-memory per-IP limiter
    ├── constants.ts                # File types/size, call duration, voice speed bounds
    └── env.ts                      # WEBSITE_ID
```

**Implementation notes:**
- **Workspaces:**
  - Signup → `/dashboard` → `/onboarding` (name + template) creates the workspace and its Retell LLM + agent, named `<slug> · <agent name>`. If Retell fails, the Agent page retries.
  - New workspaces are `trial` with `trial_seconds` (default 600) of talk time across test, widget and outbound calls, and trial limits (1 widget, 1 number, no outbound). Unfinished recent calls count as 5 minutes. Website admins grant months or suspend workspaces in `/platform`.
  - A person can own up to 3 workspaces (`va_create_workspace`, under an advisory lock).
  - Invites are copyable links. Only a SHA-256 hash of the token is stored, and accepting needs both the token and the signed-in email to match.
  - Outbound calls come from the workspace's own numbers (`va_phone_numbers`). Any workspace can call out once it has one.
  - Webhooks and inbound calls find their workspace by Retell agent ID (`va_agent_configs.retell_agent_id` is unique).
- **Training studio (draft → test → publish):**
  - Retell facts this relies on (checked against the API):
    - Publishing agent version N also publishes its LLM version; published versions are read-only.
    - `agent.createVersion({ base_version })` opens a draft. Updates without a version edit the newest one.
    - A call without `agent_version` uses the **newest version, drafts included**. Live calls (landing, widget, demo support, outbound) must pin `live_version`; only `/test-call` and the playground's Draft use the draft.
    - `agent.publish()` returns an empty body that the SDK can't parse; call it with `.asResponse()`.
    - Agents need an `end_call` tool (`END_CALL_TOOL`) to hang up. Without it, Retell test simulations end as "loop" errors. `saveDraft` and test runs add it to older agents.
  - Edits go through `saveDraft()`, which rebuilds the prompt with `buildPrompt()` and logs a change. The knowledge base isn't versioned, so FAQs, pages and files are live immediately; a new KB is attached to the draft.
  - Deleting a KB's last source would leave live versions pointing at a deleted KB, so `removeKbSource` swaps in a placeholder text instead.
  - Publishing runs `safetyProblems()` and returns 422 if the workspace's part of the prompt asks for secrets, impersonation or hiding the AI.
- **Learning from calls (Improve tab):**
  - Retell's post-call analysis gets custom fields (`ANALYSIS_FIELDS`: `resolved`, `unanswered_questions`, `caller_intent`) on top of its built-in summary, sentiment and "successful".
    - Published versions are read-only, so web and outbound calls on the workspace agent pass the fields as `agent_override.agent.post_call_analysis_data` (accepted together with `agent_version`). New agents and every `saveDraft` also set them on the agent, which covers inbound phone calls after the next publish.
  - `applyRetellCall` stores `resolved` / `caller_intent` and adds each unanswered question to `va_agent_questions`, idempotently (unique per call + question). Test and demo calls (`PRACTICE_SOURCES`) are skipped.
  - The inbox groups similar wordings by shared keywords (`groupSimilar`), not an LLM.
  - Every fix is a `va_agent_corrections` row: from a transcript (`call_log_id` + utterance `position`) or from the inbox (`question_ids`). Owners and admins apply it at once; members' fixes stay `pending` until an owner or admin applies (optionally edited) or dismisses them.
    - FAQ fixes are live once indexed, with the callers' wordings as alternates. Rule fixes are draft edits, live after Publish.
  - Widget callers rate a call 👍/👎 once, within an hour, and only through the widget that started it.
  - Transcripts are parsed from Retell's `Agent:` / `User:` text, so positions refer to that text.
- **Uploads bypass the API body limit:** the browser uploads straight to Supabase Storage via a signed URL (`<website_id>/<workspace_id>/<uuid>-<name>`), then `POST /api/w/[slug]/docs` sends the object to Retell. The server rejects paths outside the caller's workspace folder. Vercel functions cap request bodies at 4.5 MB, so files never pass through Next.js.
- **Retell source IDs arrive late:** Retell only lists KB sources once indexing completes. Documents start as `indexing`, and `GET /api/w/[slug]/docs` reconciles them to `ready` (with `retell_source_id`) or `error`. Deleting a document that is still indexing returns 409.
- **The Retell agent must use a Retell LLM response engine:** custom-LLM agents are rejected. `RETELL_AGENT_ID` is only adopted by the platform workspace; every other workspace gets a new LLM + agent from its template.
- **Plans and billing (`lib/billing.ts`):** prices are in USD; PayMongo Checkout charges the peso amount at the day's rate (`lib/fx.ts`, open.er-api.com, cached 12 hours, ₱64 fallback). Prepaid, one month at a time (GCash, Maya, GrabPay, QR Ph, cards). Nothing renews by itself.
  - Payments store the USD price (`amount_cents`, `currency`) and what was charged (`charged_amount_cents` in PHP at `exchange_rate`).
  - Visitors whose IP is in the Philippines (`x-vercel-ip-country` / `cf-ipcountry`; locally `DEV_VISITOR_COUNTRY=PH`) also see "≈ ₱" amounts.
  - `va_plans` (Starter $39 / 100 min, Growth $99 / 300 min, Business $249 / 800 min) sets minutes and limits: widgets, numbers, documents, FAQs, pages, outbound. `assertWithinLimit` / `assertOutboundAllowed` throw `BillingError` (403), which `errorResponse` always passes through.
  - Each payment is a `va_payments` row plus one Checkout Session. `va_apply_payment` (locked, idempotent) marks it paid: a renewal of the current plan starts when the paid month ends, and a new plan starts now. `va_workspaces.current_period_end` is "paid through"; the month in progress is the paid payment covering now.
  - `callLimitMs` (every web, widget, test and outbound call) caps calls to the minutes left this month (`va_workspace_usage_since`) and blocks expired or suspended workspaces. Inbound phone calls can't be refused yet, but they count.
  - Payments settle from the webhook (`PAYMONGO_WEBHOOK_SECRET`; the checkout is re-read from PayMongo, never trusted from the payload) or when the owner returns to Billing (`reconcilePayments`), which also covers local dev. A checkout session stays `active` after payment, so "paid" means a paid entry in its `payments`.
  - Numbers we provide add $3/month each to every payment; customers' own numbers are free. Staff can grant a month (amount 0, method `granted`).
  - Banners: trial minutes, 80% and 100% of the month's minutes, the month ending within 5 days unpaid, and a paused (expired) workspace. There are no emails yet.
  - Revenue report (USD): revenue from paid payments, and cost from Retell `cost_cents` plus our numbers' monthly price. Twilio call charges aren't included.
- **Booking modules (`lib/bookings.ts`, `lib/modules-agent.ts`):** reservations (services + weekly hours + capacity → appointments) and short-term rentals (apartments → stays), stored in `va_workspace_modules`, `va_services`, `va_rentals` and `va_bookings`.
  - Turning a module on adds a "## Bookings" prompt section (today's date and 14-day calendar in the business's time zone) and Retell custom functions to the **draft** via `saveDraft`. `MANAGED_TOOL_NAMES` are rebuilt on every save; other LLM tools are kept. Services, hours and apartments are read live by the functions.
  - Functions call `PUBLIC_APP_URL/api/agent-tools`, so they're only attached when that's a public https address. Locally (no tunnel) the prompt tells the agent to take details instead.
  - Results are plain sentences for the agent; `BookingError`s become "Couldn't do that: …" so the agent can offer alternatives.
  - Apartments have public fields (incl. `code`, `details`) and private ones in `va_rental_private` (owner/admin RLS): `guest_info` is returned by `get_guest_access` only after the caller gives a confirmed stay's booking reference (first 8 characters of the booking id) and the mobile number on it, from 24h before check-in to check-out, at most 3 tries per call; `internal_notes` are never sent to the agent. With more than 6 apartments `get_apartments` lists essentials and `get_apartment_details` gives one apartment's public details.
  - Appointments allow `capacity` at once (`va_book_appointment`, advisory lock); stays can't overlap per apartment (exclusion constraint, `btree_gist`).
  - Onboarding offers modules suggested by the template and seeds sample services or apartments.
  - Setup lives in Agent → Modules (admins). The workspace's **Bookings** tab (members; only while a module is on, via `modules` in `WorkspaceContext`) is the live view: it polls `/api/w/[slug]/bookings` every 15 seconds while visible and marks new bookings.
- **Phone numbers (`lib/phone-numbers.ts`):** every number lives in our one Retell account, and `va_phone_numbers` says which workspace owns it. An active number belongs to one workspace (unique index), and imports are refused if Retell already has the number.
  - **Retell (US/CA):** `phoneNumber.create`, $2/month, outbound to US/CA only. Retell picks the number from an optional area code; there's no search.
  - **Twilio:** search `AvailablePhoneNumbers` (local, else mobile) with prices from the Pricing API, buy, attach to our Elastic SIP trunk (`TWILIO_TRUNK_SID`, or the trunk whose domain is `TWILIO_SIP_TERMINATION_URI`), then `phoneNumber.import` with our trunk credentials. Off until `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are set. Inbound needs the trunk's origination URI to be `sip:sip.retellai.com`.
  - **Bring your own:** `phoneNumber.import` with the customer's termination host and SIP credentials. The credentials go to Retell only and are never stored; to change them, release and import again. Their trunk must send inbound calls to `RETELL_SIP_URI` (`sip:sip.retellai.com;transport=tcp`).
  - Inbound and outbound agents are bound with `agent_version: 'latest_published'`, so drafts never answer the phone. Turning inbound off sets `inbound_agents: null`.
  - Buying costs us money every month, so only website admins can buy for now. Workspace admins can bring their own, toggle numbers and pick the caller ID; owners release. The plan sets how many numbers a workspace may have. Retell refuses purchases until its account has a card on file (402).
  - Release deletes the number from Retell, then releases it in Twilio (ours), and marks the row `released`. It's safe to retry.
  - Without a public webhook URL (local dev), `syncInboundCalls` reads recent inbound calls for the agent from Retell when calls are listed.
  - The platform's Twilio number `+15677575800` (PH + US outbound, inbound off) was backfilled as the platform workspace's number.
- **Outbound calls (`/api/w/[slug]/calls`, `lib/outbound.ts`):** an admin starts a call with `retell.call.createPhoneCall` from the caller ID in `va_agent_configs.retell_phone_number`, which must be one of the workspace's numbers with outbound on. The destination's country must be in that number's `outbound_countries`.
  - The greeting comes from the `outbound_begin_message` template and is set per call through `agent_override.retell_llm.begin_message`. Voicemail hangs up.
  - Admins are limited to 10 calls per 10 minutes, and must confirm the person agreed to be called.
  - Call status, transcript and summary are read from Retell when the call list loads, so no webhook is needed.
- **Call tracking:** every call (landing, widget, admin test, outbound, inbound) gets a `va_call_logs` row with a `source`.
  - The Retell webhook (`/api/webhooks/retell`) updates status, duration, transcript, summary and cost.
  - `ensureAgentWebhook` registers `PUBLIC_APP_URL` + `/api/webhooks/retell` on a workspace's agent when it is created and when an admin opens its Agent page. It only does this when the URL is public https.
  - Locally Retell can't reach the app, so `listCallLogs` refreshes unfinished recent calls from Retell instead.
  - Webhooks are verified with `RETELL_WEBHOOK_KEY`, falling back to `RETELL_API_KEY`. It must be the Retell API key marked as the webhook key.
- **Widget:** `<script src="APP/widget.js" data-key="wk_…" async>` injects an iframe of `/embed/[key]`. Customer sites never load Retell code or keys.
  - The proxy sets `Content-Security-Policy: frame-ancestors 'self' <allowed_origins>` per widget, cached 30 seconds.
  - The token endpoint also checks `Sec-Fetch-Site` and the embedding page against the allow-list.
  - Admin previews log as source `test`, which analytics exclude.
  - Funnel events go to `va_widget_events`. Analytics days are bucketed in `ANALYTICS_TIMEZONE` (default `Asia/Manila`).
- **Public demo (`/demo`):** signed-in members (role `user` is enough) get `seconds_per_user` of talk time in total, not per day.
  - `va_demo_reserve` reserves time under an advisory lock. An unfinished call counts as its full reservation, so a second tab can't double-spend.
  - The call is capped with `agent_override.agent.max_call_duration_ms`.
  - A daily budget across all users is the kill switch.
  - Scenarios run on a separate demo agent (`va_demo_settings.retell_agent_id`, created on the first **Platform → Demo** visit or the first scenario call). Its prompt is `{{demo_instructions}}` plus fixed rules, filled per call through dynamic variables.
  - "Our support agent" uses the platform workspace's agent, and demo calls are logged under the platform workspace.
  - The demo agent is multilingual: `language` is a list of 21 locales (the most Retell's speech recognition accepts together) with the `11labs-Lily` voice on `eleven_flash_v2_5`. Filipino can't join that list, so the demo's "Filipino / Taglish" mode sets `agent_override.agent.language: 'fil-PH'` per call. Opening **Platform → Demo** syncs the demo agent's prompt, voice and languages from `lib/demo.ts`.
  - Retell rejects a `max_call_duration_ms` under 1 minute, so `startWebCall` never sends less; the demo page ends a shorter allowance itself.
  - Signup rejects disposable email domains.
- **Dialer uses `RetellWebClient` (legacy API in retell-client-js-sdk v3):** the newer `RetellClient` needs an API key in the browser. Pass `transport` and `ice_servers` from `createWebCall` through to `startCall`.

### B. Supabase Database Schema (SQL)
Multitenant tables are prefixed `va_` and keyed by `website_id` and `workspace_id`. Run these in the Supabase SQL Editor, in order:
1. `supabase/migrations/20261029_voice_agent_website_and_auth_isolation.sql`: website row, roles, and revoking `enroll_user_in_website` from clients
2. `supabase/migrations/20261029_voice_agent_tables.sql`: `va_agent_configs` (one row per website), `va_agent_documents`, RLS via `is_admin()`, and the private `knowledge-docs` bucket
3. `supabase/migrations/20261029_voice_agent_outbound_calls.sql`: outbound caller ID and greeting columns, plus the `va_call_logs` table
4. `supabase/migrations/20261030_voice_agent_widgets_and_tracking.sql`: `va_widgets`, `va_widget_events`, call-log tracking columns (`source`, `widget_id`, cost, …), and the `va_usage_daily` / `va_widget_funnel` analytics functions
5. `supabase/migrations/20261031_voice_agent_demo.sql`: `va_demo_settings`, `va_demo_sessions`, and the `va_demo_reserve` / `va_demo_status` / `va_demo_leads` functions (service role only)
6. `supabase/migrations/20261101_voice_agent_workspaces.sql`: `va_workspaces`, `va_workspace_members`, `va_workspace_invites`; `workspace_id` on every per-business table (backfilled to the platform workspace); member-read RLS; workspace create/usage/member/invite/console functions; per-workspace analytics functions
7. `supabase/migrations/20261102_voice_agent_training.sql`: profile / prompt mode / `live_version` on `va_agent_configs`, plus `va_agent_faqs`, `va_agent_rules`, `va_agent_changes`, `va_agent_test_cases`, `va_agent_test_runs` (member-read RLS)
8. `supabase/migrations/20261103_voice_agent_improve.sql`: analysis, feedback and review columns on `va_call_logs`, plus `va_agent_questions` and `va_agent_corrections` (member-read RLS)
9. `supabase/migrations/20261104_voice_agent_phone_numbers.sql`: `va_phone_numbers` (member-read RLS), with the platform's existing Twilio number backfilled
10. `supabase/migrations/20261105_voice_agent_billing.sql`: `va_plans` (seeded, server-only), `va_payments` (owner-read RLS), `current_period_end` on `va_workspaces`, and `va_workspace_usage_since` / `va_apply_payment` (service role only)
11. `supabase/migrations/20261106_voice_agent_usd_and_modules.sql`: USD plan prices and charged-in-PHP columns on `va_payments`; `va_workspace_modules`, `va_services`, `va_rentals`, `va_bookings` (member-read RLS) and `va_book_appointment`
12. `supabase/migrations/20261107_voice_agent_rental_details.sql`: apartment `code` / `details`, and `va_rental_private` (guest-only and team-only details, owner/admin RLS)

### C. Core Backend Implementations

#### 1. Secure Call Token Endpoint (`app/api/call/create/route.ts`)
```typescript
import { NextResponse } from 'next/server';
import Retell from 'retell-sdk';

const retell = new Retell({ apiKey: process.env.RETELL_API_KEY! });

export async function POST() {
  try {
    const webCallResponse = await retell.call.createWebCall({
      agent_id: process.env.RETELL_AGENT_ID!,
    });

    return NextResponse.json({
      access_token: webCallResponse.access_token,
      call_id: webCallResponse.call_id,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
```

#### 2. Admin Knowledge Base Upload Endpoint (`app/api/admin/docs/route.ts`)
```typescript
import { NextResponse } from 'next/server';
import Retell from 'retell-sdk';
import { createClient } from '@/lib/supabase/server';

const retell = new Retell({ apiKey: process.env.RETELL_API_KEY! });

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });

    // 1. Upload raw file to Supabase Storage for record-keeping
    const storagePath = `kb/${Date.now()}-${file.name}`;
    const { error: uploadErr } = await supabase.storage
      .from('knowledge-docs')
      .upload(storagePath, file);
    if (uploadErr) throw uploadErr;

    // 2. Fetch current config to check if Retell KB already exists
    const { data: config } = await supabase
      .from('agent_configs')
      .select('*')
      .eq('id', 1)
      .single();

    let kbId = config.retell_kb_id;

    if (!kbId) {
      // Create a new Knowledge Base in Retell with the uploaded file
      const newKb = await retell.knowledgeBase.create({
        knowledge_base_name: 'Support_Agent_KB',
        knowledge_base_files: [file],
      });
      kbId = newKb.knowledge_base_id;

      // Link the new KB to the Retell LLM and save kbId in Supabase
      await retell.llm.update(config.retell_llm_id, {
        knowledge_base_ids: [kbId],
      });
      await supabase
        .from('agent_configs')
        .update({ retell_kb_id: kbId })
        .eq('id', 1);
    } else {
      // Add file to existing Retell Knowledge Base
      await retell.knowledgeBase.addSources(kbId, {
        knowledge_base_files: [file],
      });
    }

    // 3. Log document in Supabase table
    const { data: docRow, error: dbErr } = await supabase
      .from('agent_documents')
      .insert({
        file_name: file.name,
        file_size: file.size,
        storage_path: storagePath,
      })
      .select()
      .single();

    if (dbErr) throw dbErr;

    return NextResponse.json({ document: docRow });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
```

#### 3. Frontend WebRTC Call Trigger (`app/page.tsx` snippet)
```typescript
import { RetellWebClient } from 'retell-client-js-sdk';

const retellWebClient = new RetellWebClient();

async function startSupportCall() {
  // 1. Get short-lived access token from our backend
  const res = await fetch('/api/call/create', { method: 'POST' });
  const { access_token } = await res.json();

  // 2. Start WebRTC session
  await retellWebClient.startCall({
    accessToken: access_token,
    sampleRate: 24000,
    emitRawAudioSamples: false,
  });
}
```

---

## 6. Detailed Task List by Phase

### Phase 1: Project Setup & Supabase Foundation
- [ ] **1.1 Initialize Next.js App:** Create project with App Router, TypeScript, and Tailwind CSS (`npx create-next-app@latest`).
- [ ] **1.2 Install Dependencies:** Install `retell-sdk`, `retell-client-js-sdk`, `@supabase/supabase-js`, `@supabase/ssr`, and `lucide-react`.
- [ ] **1.3 Configure Supabase Project:**
  - [ ] Run the SQL migration to create `agent_configs` and `agent_documents` tables with RLS policies.
  - [ ] Create a private Supabase Storage bucket named `knowledge-docs` and add RLS policies for authenticated users.
  - [ ] Create an initial admin user in Supabase Authentication (Email/Password).
- [ ] **1.4 Seed Initial Row:** Insert row `id = 1` in `agent_configs` with your initial `retell_agent_id` and `retell_llm_id`.

### Phase 2: Retell AI Setup & Secure Call Backend
- [ ] **2.1 Retell Dashboard Prep:** Create one base Agent and one Retell LLM in the Retell console; copy `RETELL_API_KEY`, `RETELL_AGENT_ID`, and `RETELL_LLM_ID` to `.env.local`.
- [ ] **2.2 Build Retell Singleton (`lib/retell.ts`):** Initialize server-side `Retell` client with `process.env.RETELL_API_KEY`.
- [ ] **2.3 Build Call Token Route (`app/api/call/create/route.ts`):**
  - [ ] Implement `POST` handler calling `retell.call.createWebCall()`.
  - [ ] Return `access_token` to client.
  - [ ] Add basic IP rate limiting (e.g., max 5 requests per 10 mins per IP).

### Phase 3: Visitor Landing Page & Phone Dialer UI
- [ ] **3.1 Build Landing Page Layout (`app/page.tsx`):**
  - [ ] Create clean hero section explaining the instant voice support feature.
  - [ ] Build the Phone Dialer Card component with status badge (`Ready`, `Connecting...`, `On Call • 00:42`).
- [ ] **3.2 Wire Up `RetellWebClient` Events:**
  - [ ] Listen to `call_started`, `call_ended`, `agent_start_talking`, `agent_stop_talking`, `update` (for live transcript), and `error`.
  - [ ] Add pulsing visual ring around the avatar when `agent_start_talking` fires.
  - [ ] Build Call Controls: **Start Call**, **Mute/Unmute Mic**, and **End Call**.
  - [ ] Render scrolling live transcript box showing the last 4–6 exchanges.

### Phase 4: Admin Auth & Agent Configuration Portal
- [ ] **4.1 Build Admin Auth Flow:**
  - [ ] Set up `@supabase/ssr` client helpers (`lib/supabase/server.ts` & `client.ts`).
  - [ ] Add `middleware.ts` to block unauthenticated access to `/admin` and `/api/admin/*`, and require `is_admin` for `WEBSITE_ID`.
  - [ ] Create minimal `/login` page with email/password form; sign out users without `has_website_access` for `WEBSITE_ID`.
  - [ ] Create `/signup` page that enrolls the user into `WEBSITE_ID` via `register_website_user` (role `user`).
- [ ] **4.2 Build Agent Sync API (`app/api/admin/agent/route.ts`):**
  - [ ] `GET`: Fetch current config from `agent_configs` (alongside list of uploaded docs from `agent_documents`).
  - [ ] `PATCH`: Validate session, update `retell.agent.update()` (name, voice, speed, max call duration) and `retell.llm.update()` (begin message, system prompt), then update `agent_configs` in Supabase.
- [ ] **4.3 Build Admin Settings Form (`app/admin/page.tsx`):**
  - [ ] Form inputs for Agent Name, Voice selector dropdown, Voice Speed slider (`0.5x` – `2.0x`), Opening Greeting, and System Prompt textarea.
  - [ ] Add Save button with toast/status feedback.

### Phase 5: Document Upload & Knowledge Base Sync
- [ ] **5.1 Build Document Upload API (`app/api/admin/docs/route.ts`):**
  - [ ] Validate file extension (`.pdf`, `.txt`, `.docx`, `.md`) and size (`<= 10MB`).
  - [ ] Upload file to Supabase Storage bucket `knowledge-docs`.
  - [ ] Create or append file to Retell Knowledge Base (`retell.knowledgeBase.create` or `addSources`) and ensure `knowledge_base_ids` is attached to the Retell LLM.
  - [ ] Insert metadata record into `agent_documents`.
- [ ] **5.2 Build Document Delete API (`DELETE /api/admin/docs?id=...`):**
  - [ ] Delete source from Retell KB (`retell.knowledgeBase.deleteSource`), remove file from Supabase Storage, and delete row from `agent_documents`.
- [ ] **5.3 Build Document Manager UI in `/admin`:**
  - [ ] Drag-and-drop or multi-file upload input showing upload & indexing progress.
  - [ ] List view of uploaded documents displaying filename, file size, upload timestamp, and a **Delete** button.

### Phase 6: Testing, Hardening & Deployment
- [ ] **6.1 End-to-End Verification:**
  - [ ] Upload a sample FAQ PDF in `/admin`.
  - [ ] Update the opening greeting and system prompt.
  - [ ] Open `/` in an incognito window, start a voice call, and ask a question specific to the uploaded PDF to confirm RAG retrieval works cleanly.
- [ ] **6.2 Cleanup & Edge Cases:**
  - [ ] Handle microphone permission denial gracefully with a clear UI message.
  - [ ] Ensure `retellWebClient.stopCall()` runs on component unmount.
- [ ] **6.3 Deploy to Vercel:**
  - [ ] Set `RETELL_API_KEY`, `RETELL_AGENT_ID`, `RETELL_LLM_ID`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `WEBSITE_ID` and `PUBLIC_APP_URL` (the https URL, which enables the Retell webhook) in Vercel environment variables. Also `PAYMONGO_SECRET_KEY` and `PAYMONGO_WEBHOOK_SECRET` (from `node scripts/paymongo-webhook.mjs <https url>`). Optional: `RETELL_WEBHOOK_KEY`, `ANALYTICS_TIMEZONE`, `USD_TO_PHP`, and for buying Twilio numbers `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (plus `TWILIO_SIP_TERMINATION_URI`, `TWILIO_SIP_USERNAME`, `TWILIO_SIP_PASSWORD`, optional `TWILIO_TRUNK_SID`).
