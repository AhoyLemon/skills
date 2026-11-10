// Fills a brief's {{KEY}} placeholders in one pass, and refuses to hand a session a brief with any placeholder left unfilled.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;

export const fillTemplate = (template: string, values: Record<string, string>): string => {
  const missing = new Set<string>();
  const filled = template.replace(PLACEHOLDER, (whole, key: string) => {
    const value = values[key];
    if (value === undefined) {
      missing.add(key);
      return whole;
    }
    return value;
  });
  if (missing.size > 0) throw new Error(`The brief still has unfilled placeholders: ${[...missing].join(', ')}`);
  return filled;
};

export const placeholdersIn = (template: string): string[] => [...new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ''))];

export const readBrief = (name: string): string => readFileSync(join(import.meta.dirname, '..', 'briefs', `${name}.md`), 'utf8');
