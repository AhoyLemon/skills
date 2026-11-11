// The person's side of the loop, kept pure so it can be tested: anything recorded as theirs has to be found in their own words first, and close-out waits until they've ticked or decided everything and a pass has approved.
import type { GhIssue } from './_gh.ts';
import { humanPassesSinceApproval, latestPass, MAX_HUMAN_PASSES, passPlan, waitingOnPerson, type Ledger, type Round } from './_ledger.ts';
import { regionOf } from './_render.ts';

// Only the person's own region and comments without an actua11y marker count. Text the runner wrote, even when it quotes them, never does.
export const personSources = (person: GhIssue): string[] => [regionOf(person.body) ?? '', ...person.comments.filter((comment) => !comment.body.includes('<!-- actua11y:')).map((comment) => comment.body)];

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

// Enough of their words that a fragment can't stand in for what they meant: "fine" out of "this is not fine", say.
export const MIN_WORDS = 3;

export const wordCount = (words: string): number => squash(words).split(' ').filter((word) => word !== '').length;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The words have to appear whole, starting and ending at word boundaries, so "fine" never matches inside "define".
export const foundVerbatim = (words: string, sources: string[]): boolean => {
  const wanted = squash(words);
  if (wanted === '') return false;
  const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(wanted)}(?:$|[^\\p{L}\\p{N}])`, 'u');
  return sources.some((source) => pattern.test(squash(source)));
};

export interface CloseOutCheck {
  refusals: string[];
  latest: Round | null;
  approved: boolean;
  atCap: boolean;
  stillFailing: string[];
  // Fixes decided after the last pass, which no pass ever judged. Only ever listed at the cap, where no pass is left to judge them.
  neverJudged: string[];
}

export const closeOutCheck = (ledger: Ledger, ticked: ReadonlySet<string>, allowAtCap: boolean): CloseOutCheck => {
  const refusals: string[] = [];
  if (ledger.stage !== 'human') refusals.push(ledger.stage === 'closed' ? 'This loop is already closed out' : 'The AI rounds aren\'t over yet');
  const waiting = waitingOnPerson(ledger, ticked);
  if (waiting.unticked.length > 0) refusals.push(`The person hasn't ticked ${waiting.unticked.join(', ')}, or turned ${waiting.unticked.length === 1 ? 'it' : 'them'} into a finding. Only they settle checks`);
  if (waiting.undecided.length > 0) refusals.push(`The person hasn't decided ${waiting.undecided.join(', ')}: fix, accept as is, or not applicable`);
  const latest = latestPass(ledger) ?? null;
  if (!latest) refusals.push('No certifier pass has run yet');
  const plan = passPlan(ledger);
  const judgedAt = (id: string): number | null => (ledger.items.find((item) => item.id === id)?.judged ?? ledger.human.find((item) => item.id === id)?.judged ?? null)?.pass ?? null;
  const unjudged = latest ? plan.items.filter((id) => judgedAt(id) !== latest.n) : [];
  const atCap = latest !== null && humanPassesSinceApproval(ledger) >= MAX_HUMAN_PASSES;
  if (unjudged.length > 0 && !(atCap && allowAtCap)) refusals.push(atCap ? `The latest pass didn't judge ${unjudged.join(', ')}, and the human round is at its cap. Pass --at-cap to close out anyway, and the PR lists them as never judged` : `The latest pass didn't judge ${unjudged.join(', ')}, so run the certifier once more`);
  if (latest && latest.approved !== true && !(atCap && allowAtCap)) refusals.push(atCap ? `The human round hit its cap of ${MAX_HUMAN_PASSES} certifier runs without an approving pass. Pass --at-cap to close out anyway, and the PR says so plainly` : 'The latest pass didn\'t approve. Fix what it found, push, and run the certifier again');
  const stillFailing = latest ? plan.blocking.filter((id) => {
    const judged = ledger.items.find((item) => item.id === id)?.judged ?? ledger.human.find((item) => item.id === id)?.judged ?? null;
    return judged?.pass === latest.n && judged.result === 'notFixed';
  }) : [];
  return { refusals, latest, approved: latest?.approved === true, atCap, stillFailing, neverJudged: atCap ? unjudged : [] };
};
