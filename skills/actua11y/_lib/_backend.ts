// The one seam between actua11y and whichever agent starts its sessions. Everything outside skills/actua11y/_backends/ talks to this interface only.

export type Role = 'finder' | 'dry-run';

// What a role may never do, named by intent so each backend can translate it into its own rules.
export type DenyCategory = 'git' | 'github' | 'web' | 'subagents' | 'installs';

export interface RoleSpec {
  role: Role;
  brief: string;
  cwd: string;
  scratch: string | null;
  readOnly: boolean;
  noTools: boolean;
  deny: DenyCategory[];
  offLimits: string[];
  model: string;
  effort: string;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  transcriptPath: string;
}

export interface Usage {
  costUsd: number;
  turns: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface InitInfo {
  sessionId: string;
  model: string;
  version: string;
  cwd: string;
  permissionMode: string;
  // How the session reaches the model, in words: a sign-in, or the API key it bills.
  login: string;
  tools: string[];
  mcpServers: string[];
  plugins: string[];
  skills: string[];
  agents: string[];
}

export interface SessionResult {
  sessionId: string;
  finalTexts: string[];
  init: InitInfo | null;
  usage: Usage;
  exitCode: number | null;
  timedOut: boolean;
  errors: string[];
  permissionDenials: number;
  transcriptPath: string;
}

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface BackendCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

export interface Backend {
  name: string;
  // The agent's own model id and effort scale, so nothing outside the backend has to know them.
  defaults: { model: string; effort: string };
  efforts: readonly string[];
  preflight: (repoRoot: string) => BackendCheck[];
  start: (spec: RoleSpec) => Promise<SessionResult>;
  resume: (spec: RoleSpec, sessionId: string, message: string) => Promise<SessionResult>;
  initProblems: (init: InitInfo | null, spec: RoleSpec) => string[];
  // Where this agent keeps other sessions' files outside the home folder (temp scratch, task output), so the finder can be barred from them.
  offLimits: () => string[];
}

export const emptyUsage = (): Usage => ({ costUsd: 0, turns: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

export const addUsage = (a: Usage, b: Usage): Usage => ({
  costUsd: a.costUsd + b.costUsd,
  turns: a.turns + b.turns,
  durationMs: a.durationMs + b.durationMs,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});

export const totalTokens = (usage: Usage): number => usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
