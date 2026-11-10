// Machine-readable JSON riding along in GitHub Markdown: the raw reports and the loop's ledger. Written collapsed so people can check them, and read back so any later session can resume from GitHub alone.

// GitHub refuses an issue body or comment longer than 65,536 characters. Leave headroom for its own counting.
export const GITHUB_LIMIT = 65_000;

// A fence one backtick longer than any run inside the text, so nothing inside can close it early.
export const fence = (text: string, lang = 'json'): string => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${text}\n${ticks}`;
};

// The first fenced block at or after `from`. JSON never holds a raw newline, so a closing fence can't hide inside one.
export const readFence = (text: string, from = 0): string | null => {
  const rest = text.slice(from).replace(/\r\n/g, '\n');
  const open = rest.match(/^(`{3,})[a-z]*\n/m);
  if (!open || open.index === undefined) return null;
  const start = open.index + open[0].length;
  const close = rest.slice(start).match(new RegExp(`^${open[1]}\\s*$`, 'm'));
  if (!close || close.index === undefined) return null;
  return rest.slice(start, start + close.index).replace(/\n$/, '');
};

// Splits text into pieces of at most `room` characters, never between the two halves of an emoji or any other character outside the basic plane.
export const splitText = (text: string, room: number): string[] => {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + room, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end -= 1;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks.length > 0 ? chunks : [''];
};

const attrText = (attrs: Record<string, string>): string => Object.entries(attrs).map(([key, value]) => `${key}=${value}`).join(' ');

// A raw report as one or more collapsed blocks, each marked so a reader can find and join the parts.
export const rawBlocks = (role: string, attrs: Record<string, string>, summary: string, value: unknown, room = GITHUB_LIMIT - 600): string[] => {
  const json = JSON.stringify(value, null, 2);
  const chunks = splitText(json, room);
  return chunks.map((chunk, i) => {
    const part = chunks.length > 1 ? ` (part ${i + 1} of ${chunks.length}, join the parts to parse)` : '';
    return `<!-- actua11y:raw v1 role=${role} ${attrText(attrs)} part=${i + 1}/${chunks.length} -->\n<details>\n<summary>${summary}${part}</summary>\n\n${fence(chunk)}\n\n</details>\n`;
  });
};

interface RawPart {
  role: string;
  attrs: Record<string, string>;
  part: number;
  of: number;
  text: string;
}

const RAW_MARKER = /<!-- actua11y:raw v1 role=([a-z]+)((?: [a-z]+=[^\s]+)*?) part=(\d+)\/(\d+) -->/g;

const rawParts = (bodies: string[]): RawPart[] =>
  bodies.flatMap((body) =>
    [...body.matchAll(RAW_MARKER)].flatMap((match) => {
      const text = readFence(body, (match.index ?? 0) + match[0].length);
      if (text === null) return [];
      const attrs = Object.fromEntries((match[2] ?? '').trim().split(' ').filter((pair) => pair !== '').map((pair) => pair.split('=') as [string, string]));
      return [{ role: match[1] ?? '', attrs, part: Number(match[3]), of: Number(match[4]), text }];
    }),
  );

// Joins every part of one raw report and parses it, or returns null if any part is missing.
export const readRaw = (bodies: string[], role: string, match: Record<string, string>): unknown => {
  const parts = rawParts(bodies).filter((part) => part.role === role && Object.entries(match).every(([key, value]) => part.attrs[key] === value));
  const of = parts[0]?.of ?? 0;
  if (of === 0) return null;
  const ordered: string[] = [];
  for (let i = 1; i <= of; i += 1) {
    const piece = parts.find((part) => part.part === i);
    if (!piece) return null;
    ordered.push(piece.text);
  }
  try {
    return JSON.parse(ordered.join('')) as unknown;
  } catch {
    return null;
  }
};

// Every value an attribute takes across the raw reports of one role, so a reader can find every certifier pass without knowing how many there were.
export const rawValues = (bodies: string[], role: string, key: string): string[] => [...new Set(rawParts(bodies).filter((part) => part.role === role).map((part) => part.attrs[key] ?? '').filter((value) => value !== ''))];
