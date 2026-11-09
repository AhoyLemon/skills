// Runs axe on one page in the installed Chrome or Edge and writes a trimmed result. Copied into each run's scratch folder and run there, next to its node_modules.
// Usage: node kit/scan.ts --probe
//        node kit/scan.ts --url <url> --tags wcag2a,wcag21a --out <file.json> [--channel auto|chrome|msedge] [--viewport 1280x800] [--wait <ms>]
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Browser } from 'playwright-core';

interface Launched {
  browser: Browser;
  channel: string;
}

interface TrimmedNode {
  target: string;
  html: string;
  summary: string;
}

interface TrimmedRule {
  id: string;
  impact: string;
  help: string;
  helpUrl: string;
  tags: string[];
  nodeCount: number;
  nodes: TrimmedNode[];
}

const { values } = parseArgs({
  options: {
    probe: { type: 'boolean', default: false },
    url: { type: 'string' },
    tags: { type: 'string', default: '' },
    out: { type: 'string' },
    channel: { type: 'string', default: 'auto' },
    viewport: { type: 'string', default: '1280x800' },
    wait: { type: 'string', default: '0' },
  },
});

const axeVersion = (): string => (createRequire(import.meta.url)('axe-core/package.json') as { version: string }).version;

// The installed Chrome or Edge first. 'chromium' is Playwright's own build, there only if someone ran `npx playwright@1.65.0 install chromium`.
const launch = async (wanted: string): Promise<Launched> => {
  const channels = wanted === 'auto' ? ['chrome', 'msedge', 'chromium'] : [wanted];
  const failures: string[] = [];
  for (const channel of channels) {
    try {
      return { browser: await chromium.launch({ channel, headless: true }), channel };
    } catch (error) {
      failures.push(`${channel}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }
  throw new Error(`No Chrome, Edge or Playwright Chromium to drive. ${failures.join(' | ')}`);
};

const viewportOf = (text: string): { width: number; height: number } => {
  const [width, height] = text.split('x').map(Number);
  return { width: width || 1280, height: height || 800 };
};

const trimRule = (rule: { id: string; impact?: string | null; help: string; helpUrl: string; tags: string[]; nodes: { target: unknown; html: string; failureSummary?: string }[] }): TrimmedRule => ({
  id: rule.id,
  impact: rule.impact ?? '',
  help: rule.help,
  helpUrl: rule.helpUrl,
  tags: rule.tags,
  nodeCount: rule.nodes.length,
  nodes: rule.nodes.slice(0, 25).map((node) => ({ target: JSON.stringify(node.target), html: node.html.slice(0, 300), summary: (node.failureSummary ?? '').slice(0, 500) })),
});

const main = async (): Promise<void> => {
  const { browser, channel } = await launch(values.channel);
  try {
    if (values.probe) {
      process.stdout.write(`${JSON.stringify({ channel, version: browser.version(), axeVersion: axeVersion() })}\n`);
      return;
    }
    if (!values.url || !values.out) throw new Error('Pass --url and --out, or --probe');
    const viewport = viewportOf(values.viewport);
    const page = await browser.newPage({ viewport });
    try {
      await page.goto(values.url, { waitUntil: 'networkidle', timeout: 30_000 });
    } catch {
      await page.goto(values.url, { waitUntil: 'load', timeout: 30_000 });
    }
    const wait = Number(values.wait);
    if (wait > 0) await page.waitForTimeout(wait);
    const tags = values.tags.split(',').filter((tag) => tag !== '');
    const builder = new AxeBuilder({ page });
    if (tags.length > 0) builder.withTags(tags);
    const results = await builder.analyze();
    const trimmed = {
      url: values.url,
      scannedAt: new Date().toISOString(),
      browser: { channel, version: browser.version() },
      axe: { version: axeVersion(), tags },
      viewport,
      note: 'axe covers part of WCAG. Each rule lists at most 25 of its nodeCount nodes. A violation is a lead to verify in the source. Incomplete means axe could not decide. A rule with no violations covers that one rule on this page, never a whole criterion.',
      violations: results.violations.map(trimRule),
      incomplete: results.incomplete.map(trimRule),
      passes: results.passes.map((rule) => ({ id: rule.id, help: rule.help, tags: rule.tags, nodeCount: rule.nodes.length })),
      inapplicable: results.inapplicable.map((rule) => rule.id),
    };
    writeFileSync(values.out, `${JSON.stringify(trimmed, null, 2)}\n`);
    process.stdout.write(`${values.url}: ${trimmed.violations.length} violation rule(s), ${trimmed.incomplete.length} incomplete, ${trimmed.passes.length} with no violations\n`);
  } finally {
    await browser.close();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
