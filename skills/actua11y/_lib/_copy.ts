// The words actua11y must say every time, kept in one place so code (not a model's memory) puts them on every run and every report.
import type { Level } from './_criteria.ts';

export const BEST_FAITH = "actua11y is Lemon's best-faith effort, and it guarantees nothing. A machine can prove a fail, and it can never prove a pass, so treat everything here as a floor, not a certificate.";

export const AAA_WARNING = "The target is AAA. This is a best effort, not a claim. Real AAA conformance needs a qualified accessibility specialist and testing with disabled people, and WCAG itself doesn't recommend AAA as a blanket target for a whole site.";

export const BROWSER_WHY = 'actua11y drives a real browser (your installed Chrome or Edge, headless) because keyboard behaviour, focus and rendered contrast only exist once a page is running.';

export const VERDICT_KEY: readonly { mark: string; means: string }[] = [
  { mark: '✅', means: 'a machine found no fail, by doing something specific (the evidence is attached so you can challenge it)' },
  { mark: '❌', means: 'a machine proved a fail' },
  { mark: '🕵️', means: "a machine can't settle it, so a person has to check" },
  { mark: 'n/a', means: "the criterion doesn't apply here" },
];

export const warningsFor = (level: Level): string[] => (level === 'AAA' ? [BEST_FAITH, AAA_WARNING] : [BEST_FAITH]);
