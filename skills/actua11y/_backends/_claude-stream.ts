// Reads Claude Code's stream-json events. Every result event counts: a session can wake for more turns after its job, and each wake ends in a result of its own.
import { emptyUsage, type InitInfo, type Usage } from '../_lib/_backend.ts';

export interface StreamSummary {
  init: InitInfo | null;
  finalTexts: string[];
  usage: Usage;
  sessionId: string;
  permissionDenials: number;
  errors: string[];
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

const names = (value: unknown, key = 'name'): string[] => (Array.isArray(value) ? value.map((item) => (isRecord(item) ? String(item[key] ?? '') : String(item))).filter((name) => name !== '') : []);

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

// apiKeySource is "none" for a subscription sign-in (or a cloud provider), and otherwise names the key the session bills.
const loginOf = (source: unknown): string => (typeof source !== 'string' || source === 'none' ? 'no API key, so your Claude sign-in (or Bedrock or Vertex, if you set one up)' : `${source}, billed to that API account`);

const initFrom = (event: Json): InitInfo => ({
  sessionId: String(event['session_id'] ?? ''),
  model: String(event['model'] ?? ''),
  version: String(event['claude_code_version'] ?? ''),
  cwd: String(event['cwd'] ?? ''),
  permissionMode: String(event['permissionMode'] ?? ''),
  login: loginOf(event['apiKeySource']),
  tools: strings(event['tools']),
  mcpServers: names(event['mcp_servers']),
  plugins: Array.isArray(event['plugins']) ? event['plugins'].filter(isRecord).map((plugin) => `${String(plugin['name'] ?? '')}@${String(plugin['path'] ?? '')}`) : [],
  skills: names(event['skills']),
  agents: names(event['agents']),
});

// modelUsage covers subagents too and is cumulative within a process, so the last result's figures are the process's totals.
const usageFrom = (event: Json): Usage => {
  const usage = emptyUsage();
  usage.costUsd = num(event['total_cost_usd']);
  usage.turns = num(event['num_turns']);
  usage.durationMs = num(event['duration_ms']);
  const models = event['modelUsage'];
  if (isRecord(models)) {
    for (const model of Object.values(models)) {
      if (!isRecord(model)) continue;
      usage.inputTokens += num(model['inputTokens']);
      usage.outputTokens += num(model['outputTokens']);
      usage.cacheReadTokens += num(model['cacheReadInputTokens']);
      usage.cacheWriteTokens += num(model['cacheCreationInputTokens']);
    }
  }
  return usage;
};

export const parseStream = (lines: string[]): StreamSummary => {
  const summary: StreamSummary = { init: null, finalTexts: [], usage: emptyUsage(), sessionId: '', permissionDenials: 0, errors: [] };
  for (const line of lines) {
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event['type'] === 'system' && event['subtype'] === 'init') {
      summary.init = initFrom(event);
      summary.sessionId = summary.init.sessionId;
    }
    if (event['type'] !== 'result') continue;
    summary.sessionId = String(event['session_id'] ?? summary.sessionId);
    const failed = event['is_error'] === true || (typeof event['subtype'] === 'string' && event['subtype'] !== 'success');
    const text = typeof event['result'] === 'string' ? event['result'] : '';
    if (!failed && text !== '') summary.finalTexts.push(text);
    summary.usage = usageFrom(event);
    summary.permissionDenials = Array.isArray(event['permission_denials']) ? event['permission_denials'].length : summary.permissionDenials;
    if (failed) {
      // An API failure (an expired sign-in, say) arrives as subtype success with is_error set, so terminal_reason names it and result says why.
      const why = event['subtype'] === 'success' && typeof event['terminal_reason'] === 'string' ? event['terminal_reason'] : String(event['subtype']);
      const detail = [...strings(event['errors']), ...(text !== '' ? [text] : [])];
      summary.errors.push(`${why}${detail.length > 0 ? `: ${detail.join('; ')}` : ''}`);
    }
  }
  return summary;
};
