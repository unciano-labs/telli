import 'server-only';
import { createAdminClient } from '@/lib/supabase/server';
import { getRetell } from '@/lib/retell';
import { WEBSITE_ID } from '@/lib/env';
import { ensureEndCallTool, prepareDraft } from '@/lib/agent-draft';
import type { AgentConfig } from '@/lib/agent-config';
import type { Workspace } from '@/lib/workspaces';

export type TestCase = {
  id: string;
  name: string;
  caller: string;
  expectation: string;
  retell_definition_id: string | null;
  created_at: string;
};

export type TestResult = { test_case_id: string; name: string; status: string; explanation: string | null };

export type TestRun = {
  id: string;
  agent_version: number;
  status: 'running' | 'complete';
  pass_count: number;
  fail_count: number;
  error_count: number;
  total_count: number;
  results: TestResult[];
  draft_changed_at: string | null;
  created_at: string;
  completed_at: string | null;
};

export type TestCaseInput = Pick<TestCase, 'name' | 'caller' | 'expectation'>;

export class TestError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

export const MAX_TEST_CASES = 30;

function db() {
  return createAdminClient();
}

export function validateTestCase(body: Record<string, unknown>): TestCaseInput {
  const str = (key: string) => (typeof body[key] === 'string' ? (body[key] as string).trim() : '');
  const input = { name: str('name'), caller: str('caller'), expectation: str('expectation') };
  if (!input.name || input.name.length > 120) throw new TestError('Name is required (max 120 characters)', 400);
  if (!input.caller || input.caller.length > 1000) {
    throw new TestError('Describe what the caller says or asks (max 1,000 characters)', 400);
  }
  if (!input.expectation || input.expectation.length > 500) {
    throw new TestError('Describe what a good answer does (max 500 characters)', 400);
  }
  return input;
}

/** The simulated caller Retell plays against the agent. */
function callerPrompt(workspace: Workspace, input: TestCaseInput) {
  return `You are a caller phoning ${workspace.name}. ${input.caller}
Talk naturally, one short message at a time. Once you have your answer, thank them and say goodbye.`;
}

function definitionParams(workspace: Workspace, config: AgentConfig, input: TestCaseInput) {
  return {
    name: `${workspace.slug}: ${input.name}`.slice(0, 120),
    user_prompt: callerPrompt(workspace, input),
    metrics: [input.expectation],
    response_engine: { type: 'retell-llm' as const, llm_id: config.retell_llm_id },
  };
}

export async function listTestCases(workspace: Workspace): Promise<TestCase[]> {
  const { data, error } = await db()
    .from('va_agent_test_cases')
    .select('id, name, caller, expectation, retell_definition_id, created_at')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Failed to load test cases: ${error.message}`);
  return data as TestCase[];
}

export async function createTestCase(workspace: Workspace, userId: string, input: TestCaseInput): Promise<TestCase> {
  if ((await listTestCases(workspace)).length >= MAX_TEST_CASES) {
    throw new TestError(`Up to ${MAX_TEST_CASES} test cases`, 400);
  }
  const config = await prepareDraft(workspace);
  const definition = await getRetell().tests.createTestCaseDefinition(definitionParams(workspace, config, input));
  const { data, error } = await db()
    .from('va_agent_test_cases')
    .insert({
      website_id: WEBSITE_ID,
      workspace_id: workspace.id,
      ...input,
      retell_definition_id: definition.test_case_definition_id,
      created_by: userId,
    })
    .select('id, name, caller, expectation, retell_definition_id, created_at')
    .single();
  if (error) {
    await getRetell().tests.deleteTestCaseDefinition(definition.test_case_definition_id).catch(() => {});
    throw new Error(`Failed to save test case: ${error.message}`);
  }
  return data as TestCase;
}

export async function updateTestCase(workspace: Workspace, id: string, input: TestCaseInput): Promise<TestCase> {
  const existing = (await listTestCases(workspace)).find((t) => t.id === id);
  if (!existing) throw new TestError('Test case not found', 404);
  const config = await prepareDraft(workspace);
  const retell = getRetell();
  let definitionId = existing.retell_definition_id;
  if (definitionId) {
    await retell.tests.updateTestCaseDefinition(definitionId, definitionParams(workspace, config, input));
  } else {
    definitionId = (await retell.tests.createTestCaseDefinition(definitionParams(workspace, config, input)))
      .test_case_definition_id;
  }
  const { data, error } = await db()
    .from('va_agent_test_cases')
    .update({ ...input, retell_definition_id: definitionId, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspace.id)
    .eq('id', id)
    .select('id, name, caller, expectation, retell_definition_id, created_at')
    .single();
  if (error) throw new Error(`Failed to save test case: ${error.message}`);
  return data as TestCase;
}

export async function deleteTestCase(workspace: Workspace, id: string): Promise<void> {
  const existing = (await listTestCases(workspace)).find((t) => t.id === id);
  if (!existing) throw new TestError('Test case not found', 404);
  if (existing.retell_definition_id) {
    await getRetell().tests.deleteTestCaseDefinition(existing.retell_definition_id).catch((err) => {
      if ((err as { status?: number }).status !== 404) throw err;
    });
  }
  await db().from('va_agent_test_cases').delete().eq('workspace_id', workspace.id).eq('id', id);
}

/** Runs every test case against the current draft (Retell simulates the callers). */
export async function startTestRun(workspace: Workspace, userId: string): Promise<TestRun> {
  const cases = (await listTestCases(workspace)).filter((t) => t.retell_definition_id);
  if (!cases.length) throw new TestError('Add a test case first', 400);
  const running = await latestTestRun(workspace);
  if (running?.status === 'running') throw new TestError('Tests are already running', 409);

  let config = await prepareDraft(workspace);
  await ensureEndCallTool(workspace, config);
  config = await prepareDraft(workspace);
  const retell = getRetell();
  const draft = await retell.agent.retrieve(config.retell_agent_id);
  const engine = draft.response_engine;
  if (engine.type !== 'retell-llm') throw new TestError('Only Retell LLM agents can be tested', 400);

  const batch = await retell.tests.createBatchTest({
    response_engine: { type: 'retell-llm', llm_id: engine.llm_id, version: engine.version ?? null },
    test_case_definition_ids: cases.map((c) => c.retell_definition_id!),
  });
  const { data, error } = await db()
    .from('va_agent_test_runs')
    .insert({
      website_id: WEBSITE_ID,
      workspace_id: workspace.id,
      retell_batch_id: batch.test_case_batch_job_id,
      agent_version: draft.version,
      total_count: batch.total_count,
      draft_changed_at: config.draft_changed_at,
      created_by: userId,
    })
    .select('*')
    .single();
  if (error) throw new Error(`Failed to save test run: ${error.message}`);
  return data as TestRun;
}

/** The newest run, refreshed from Retell while it's still running. */
export async function latestTestRun(workspace: Workspace): Promise<TestRun | null> {
  const { data, error } = await db()
    .from('va_agent_test_runs')
    .select('*')
    .eq('website_id', WEBSITE_ID)
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load test run: ${error.message}`);
  if (!data) return null;
  const run = data as TestRun & { retell_batch_id: string };
  if (run.status !== 'running') return run;

  const retell = getRetell();
  const batch = await retell.tests.getBatchTest(run.retell_batch_id);
  if (batch.status !== 'complete') return run;

  const cases = await listTestCases(workspace);
  const byDefinition = new Map(cases.map((c) => [c.retell_definition_id, c]));
  const jobs = await retell.tests.listTestRuns(run.retell_batch_id, { limit: 100 });
  const results: TestResult[] = jobs.items.map((job) => {
    const testCase = byDefinition.get(job.test_case_definition_id);
    return {
      test_case_id: testCase?.id ?? job.test_case_definition_id,
      name: testCase?.name ?? job.test_case_definition_snapshot?.name ?? 'Deleted test case',
      status: job.status,
      explanation: job.result_explanation ?? null,
    };
  });
  const { data: saved, error: saveErr } = await db()
    .from('va_agent_test_runs')
    .update({
      status: 'complete',
      pass_count: batch.pass_count,
      fail_count: batch.fail_count,
      error_count: batch.error_count,
      total_count: batch.total_count,
      results,
      completed_at: new Date().toISOString(),
    })
    .eq('workspace_id', workspace.id)
    .eq('id', run.id)
    .select('*')
    .single();
  if (saveErr) throw new Error(`Failed to save test results: ${saveErr.message}`);
  return saved as TestRun;
}

export type PlaygroundMessage = { role: 'agent' | 'user'; content: string };

const MAX_TURNS = 40;

/** One text reply from the draft or live agent, without using voice minutes. */
export async function playgroundReply(
  workspace: Workspace,
  version: 'draft' | 'live',
  messages: PlaygroundMessage[]
): Promise<string[]> {
  if (!messages.length || messages.length > MAX_TURNS) throw new TestError(`Send 1–${MAX_TURNS} messages`, 400);
  const config = await prepareDraft(workspace);
  const retell = getRetell();
  const pinned = version === 'live' ? config.live_version : (await retell.agent.retrieve(config.retell_agent_id)).version;
  const res = await retell.playground.completion(config.retell_agent_id, {
    ...(pinned !== null && { version: pinned }),
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });
  return res.messages.flatMap((m) => ('content' in m && typeof m.content === 'string' && m.content ? [m.content] : []));
}
