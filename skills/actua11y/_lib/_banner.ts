// The first thing every runner command prints, so the best-faith line can't be skipped by whoever is driving.
import { bold, dim, out, yellow } from './_ansi.ts';
import { AAA_WARNING, BEST_FAITH } from './_copy.ts';
import type { Level } from './_criteria.ts';

export const banner = (level: Level | null): void => {
  out(bold('actua11y'));
  out(dim(BEST_FAITH));
  if (level === 'AAA') out(yellow(AAA_WARNING));
};
