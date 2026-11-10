// The words actua11y must say every time, kept in one place so code (not a model's memory) puts them on every run and every report.
import { bold, dim, out, yellow } from './_ansi.ts';
import type { Level } from './_criteria.ts';

export const BEST_FAITH = "actua11y is Lemon's best-faith effort, and it guarantees nothing. A machine can prove a fail, and it can never prove a pass, so treat everything here as a floor, not a certificate.";

export const AAA_WARNING = "The target is AAA. This is a best effort, not a claim. Meeting AAA for real needs a qualified accessibility specialist and testing with disabled people, and WCAG itself doesn't recommend AAA as a blanket target for a whole site.";

export const VERDICT_KEY: readonly { mark: string; means: string }[] = [
  { mark: '✅', means: 'a machine found no fail, by doing something specific (the evidence is attached so you can challenge it)' },
  { mark: '❌', means: 'a machine proved a fail' },
  { mark: '🕵️', means: "a machine can't settle it, so a person has to check" },
  { mark: 'n/a', means: "the criterion doesn't apply here" },
];

export const warningsFor = (level: Level): string[] => (level === 'AAA' ? [BEST_FAITH, AAA_WARNING] : [BEST_FAITH]);

// The first thing every runner command prints, so the best-faith line can't be skipped by whoever is driving.
export const banner = (level: Level | null): void => {
  out(bold('actua11y'));
  out(dim(BEST_FAITH));
  if (level === 'AAA') out(yellow(AAA_WARNING));
};
