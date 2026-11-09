// Presses Tab through one page in the installed Chrome or Edge and records where focus lands, whether it can be seen, and whether it gets stuck. Copied into each run's scratch folder and run there.
// Usage: node kit/tabwalk.ts --url <url> [--out <file.json>] [--max 80] [--viewport 1280x800] [--channel auto|chrome|msedge]
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { chromium, type Browser } from 'playwright-core';

interface FocusStep {
  index: number;
  selector: string;
  tag: string;
  role: string;
  name: string;
  rect: { x: number; y: number; width: number; height: number };
  inViewport: boolean;
  indicatorChanged: boolean;
  focusedStyle: Record<string, string>;
  unfocusedStyle: Record<string, string>;
}

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    out: { type: 'string' },
    max: { type: 'string', default: '80' },
    viewport: { type: 'string', default: '1280x800' },
    channel: { type: 'string', default: 'auto' },
  },
});

const launch = async (wanted: string): Promise<{ browser: Browser; channel: string }> => {
  for (const channel of wanted === 'auto' ? ['chrome', 'msedge'] : [wanted]) {
    try {
      return { browser: await chromium.launch({ channel, headless: true }), channel };
    } catch {
      // Try the next channel.
    }
  }
  throw new Error('No Chrome or Edge to drive');
};

const main = async (): Promise<void> => {
  if (!values.url) throw new Error('Pass --url');
  const [width, height] = values.viewport.split('x').map(Number);
  const { browser, channel } = await launch(values.channel);
  try {
    const page = await browser.newPage({ viewport: { width: width || 1280, height: height || 800 } });
    await page.goto(values.url, { waitUntil: 'load', timeout: 30_000 });
    const steps: FocusStep[] = [];
    let trapSuspected = false;
    let cycleComplete = false;
    let repeats = 0;
    for (let index = 0; index < Number(values.max); index += 1) {
      await page.keyboard.press('Tab');
      const step = await page.evaluate((i): FocusStep | null => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body || el === document.documentElement) return null;
        const props = ['outline-style', 'outline-width', 'outline-color', 'outline-offset', 'box-shadow', 'background-color', 'border-color', 'color', 'text-decoration-line'];
        const read = (): Record<string, string> => {
          const style = getComputedStyle(el);
          return Object.fromEntries(props.map((prop) => [prop, style.getPropertyValue(prop)]));
        };
        const focusedStyle = read();
        el.blur();
        const unfocusedStyle = read();
        el.focus();
        const selectorOf = (node: Element): string => {
          const parts: string[] = [];
          let current: Element | null = node;
          while (current && parts.length < 4 && current !== document.body) {
            let part = current.tagName.toLowerCase();
            if (current.id) part += `#${current.id}`;
            else if (current.classList.length > 0) part += `.${[...current.classList].slice(0, 2).join('.')}`;
            parts.unshift(part);
            current = current.parentElement;
          }
          return parts.join(' > ');
        };
        const rect = el.getBoundingClientRect();
        const name = (el.getAttribute('aria-label') ?? el.getAttribute('alt') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
        return {
          index: i,
          selector: selectorOf(el),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') ?? '',
          name,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
          indicatorChanged: props.some((prop) => focusedStyle[prop] !== unfocusedStyle[prop]),
          focusedStyle,
          unfocusedStyle,
        };
      }, index);
      if (!step) {
        if (steps.length > 0) cycleComplete = true;
        break;
      }
      const previous = steps.at(-1);
      repeats = previous && previous.selector === step.selector ? repeats + 1 : 0;
      if (repeats >= 3) {
        trapSuspected = true;
        break;
      }
      if (steps.length > 0 && steps[0]?.selector === step.selector) {
        cycleComplete = true;
        break;
      }
      steps.push(step);
    }
    const result = {
      url: values.url,
      browser: { channel, version: browser.version() },
      note: 'One engine, one viewport. indicatorChanged compares computed styles focused and unfocused, so it says something changed, not that a person can see it. Contrast of the indicator is a separate check.',
      cycleComplete,
      trapSuspected,
      steps,
    };
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (values.out) writeFileSync(values.out, json);
    else process.stdout.write(json);
  } finally {
    await browser.close();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
