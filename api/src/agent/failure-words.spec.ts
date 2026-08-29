/**
 * BEA-1580 — every failure a customer sees ends in one of his six moves; plumbing is never his
 * problem.
 *
 * The locking half walks the REAL failure strings from the 2026-08-29 audit — the ones named in the
 * Linear issue and the ones read back from the live `AgentRun` / `WorkerBuild` history that day —
 * and asserts each classifies the intended way. If a wording changes upstream and stops
 * classifying, this test is what says so before a customer does.
 */
import * as fs from 'fs';
import * as path from 'path';
import { doubtLine } from '../social/run-doubt';
import { stopWords } from '../worker/repair';
import {
  CHAT_EDIT_WORDS,
  PLUMBING_CLASSES,
  customerWords,
  endsInMove,
  moveOf,
  plumbingClassOf,
  plumbingWords,
} from './failure-words';

// ---- the audit's plumbing strings: OUR infrastructure, never presented as his problem ------------

const PLUMBING_FROM_THE_AUDIT: Array<[string, string]> = [
  // [the honest internal sentence, the class it must land in]
  ['The worker could not be started — the worker runner could not be reached (fetch failed).', 'runner-unreachable'],
  ['The installed worker (v2) has no readable meta.json, so its kit version is unknown — it needs a rebuild.', 'worker-install-broken'],
  ['Could not read the kit versions (worker "x", app "1") — the worker needs a rebuild.', 'worker-install-broken'],
  ['The installed worker has no worker.mjs (v3).', 'worker-install-broken'],
  ['the worker is not repeatable: at call 3 it did "writeSheet", but this run did "fetchSource" there. Nothing was repeated.', 'not-repeatable'],
  ['NOT_REPEATABLE', 'not-repeatable'],
  ["This job's worker was built for kit v2 and My Brain is on kit v1, so it was not started.", 'kit-mismatch'],
  ['The worker stopped without saying why.', 'worker-crash'],
  ['the worker exited with code 1', 'worker-crash'],
  ['The app stopped listening, so the worker was stopped.', 'app-restart'],
  ['The worker runner cannot use its workers folder, so nothing was started — EACCES on /srv/mybrain-workers.', 'runner-root-unusable'],
  // 2026-08-29 17:36 live: a transient OpenRouter blank — the run self-repaired minutes later.
  ['the worker-think model returned nothing', 'model-blank'],
  ['Could not shape the rows: the shaping model returned nothing (is a model chosen for "Social rows model" in Settings?)', 'model-blank'],
  ['the alert model could not be reached — fetch failed', 'model-blank'],
];

// ---- the audit's customer-actionable strings: each must end in one of the six moves --------------

const ACTIONABLE_FROM_THE_AUDIT: string[] = [
  'This run stopped making progress — nothing was written for 20 minutes, so it was stopped. Nothing half-finished was left behind; run it again when you like.',
  'No worker is installed for this job yet.',
  'Reddit search timed out after 240 seconds; nothing was written.',
  'The worker took too long and was stopped after 300s.',
  'Could not fetch Reddit: Reddit could not do that: fetch failed (ETIMEDOUT)',
  'Could not fetch Reddit: Reddit could not do that: Internal Server Error',
  'I stopped before writing anything: The goal asks for 100 posts, but Reddit returned only 90 usable posts.',
  'This job has no source called "svc:reddit.subreddit".',
  'The report selected 6 important emails but only has 3 two-line summaries.',
  "Notion could not do that: Invalid request data provided - Following fields are missing: {'parent_id'}",
  'Reddit paging did not finish, so the complete result set is unknown and nothing was written.',
  "Reddit's top/week results were not in descending score order at post 1w0hdha; nothing was written.",
  'Connect Google Sheets first — open /tools, connect Google Sheets, then run this job again.',
  'Nothing came back to write — the fetch answered with no items. Check the arguments on the job, or try again later.',
];

describe('plumbingClassOf — the audit strings land in their classes (BEA-1581 alerts on these ids)', () => {
  it.each(PLUMBING_FROM_THE_AUDIT)('%s → %s', (sentence, classId) => {
    expect(plumbingClassOf(sentence)).toBe(classId);
  });

  it('the classes are data: unique ids, and every id the audit needs exists', () => {
    const ids = PLUMBING_CLASSES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [, classId] of PLUMBING_FROM_THE_AUDIT) expect(ids).toContain(classId);
  });

  it('the calm shape never repeats the internal jargon, and still gives him a move', () => {
    for (const [sentence] of PLUMBING_FROM_THE_AUDIT) {
      const shown = customerWords(sentence);
      expect(shown).not.toMatch(/meta\.json|NOT_REPEATABLE|not repeatable|worker runner|kit v\d|exited with code|workers folder/i);
      expect(endsInMove(shown)).toBe(true); // "run it again when you like" / "it will work on the next run" family
    }
  });

  it('a failure with no reason at all is ours, never his', () => {
    expect(customerWords('')).toBe(plumbingWords());
    expect(customerWords(null)).toBe(plumbingWords());
  });

  it('the model-blank class carries its own calm line — transient AI, nothing lost', () => {
    expect(customerWords('the worker-think model returned nothing')).toMatch(/AI could not be reached just now/);
    expect(customerWords('the worker-think model returned nothing')).toMatch(/nothing was lost/i);
  });
});

describe('customerWords — every actionable audit string ends in one of the six moves, named plainly', () => {
  it.each(ACTIONABLE_FROM_THE_AUDIT.map((s) => [s]))('%s', (sentence) => {
    expect(plumbingClassOf(sentence)).toBeNull(); // honest failures stay his to read
    const shown = customerWords(sentence);
    expect(shown.startsWith(sentence.trim().slice(0, 40))).toBe(true); // never softened — the reason survives whole
    expect(endsInMove(shown)).toBe(true);
  });

  it("a raw transport failure gets the WAIT move — never the /tools door (Node's own jargon is `connect ECONNREFUSED …`)", () => {
    // `describeTransportError()` (tools/transport.ts) shapes every HTTP provider's network blip
    // like this, and it rides into run errors through the ordinary catch sites. The word "connect"
    // in it is an errno, not an instruction — the review caught both regexes over-matching it.
    const s = 'Could not reach the service: fetch failed (ECONNREFUSED: connect ECONNREFUSED 1.2.3.4:443)';
    expect(plumbingClassOf(s)).toBeNull();
    expect(endsInMove(s)).toBe(false); // raw jargon is NOT already compliant
    expect(moveOf(s)).toBe('wait');
    const shown = customerWords(s);
    expect(shown).toMatch(/Try again in an hour\.$/);
    expect(shown).not.toMatch(/\/tools/); // no "Open Tools" button over a network blip
  });

  it('a vendor timeout waits; a missing worker rebuilds; /tools stays a connect', () => {
    expect(moveOf('Reddit search timed out after 240 seconds; nothing was written.')).toBe('wait');
    expect(customerWords('No worker is installed for this job yet.')).toMatch(/Rebuild its worker in Settings → Worker/);
    expect(moveOf('Connect Google Sheets first — open /tools…')).toBe('connect-tool');
  });

  it('a message that already ends in its move passes through UNTOUCHED', () => {
    for (const s of [
      'This run stopped making progress — nothing was written for 20 minutes, so it was stopped. Nothing half-finished was left behind; run it again when you like.',
      'Connect Google Sheets first — open /tools, connect Google Sheets, then run this job again.',
      'Nothing came back to write — the fetch answered with no items. Check the arguments on the job, or try again later.',
    ]) {
      expect(customerWords(s)).toBe(s);
    }
  });
});

// ---- MUST NOT change: the three older rules this one builds around -------------------------------

describe('guards on BEA-1575, BEA-1403 and the repair pause message', () => {
  it("BEA-1575's chatEdit reasons are absorbed as data, not re-worded — and each is already compliant", () => {
    expect(CHAT_EDIT_WORDS.didNotUnderstand).toBe("I couldn't work that one out — try saying it another way.");
    expect(CHAT_EDIT_WORDS.promptMissing).toBe('Editing by chat is switched off — its prompt is missing in Settings → Prompts.');
    expect(CHAT_EDIT_WORDS.budget).toBe("The AI could not be reached just now — usually the day's AI budget is used up. Nothing was changed; try again later.");
    expect(CHAT_EDIT_WORDS.unreadableReply).toBe("The AI answered, but not in a form I could read. Nothing was changed — say it another way and I'll try again.");
    for (const s of Object.values(CHAT_EDIT_WORDS)) {
      expect(plumbingClassOf(s)).toBeNull(); // "The AI could not be reached just now — …budget…" is HIS wait-move, not model-blank
      expect(customerWords(s)).toBe(s); // untouched — each already ends in its move
    }
    // BEA-1575's own test reads these sentences out of the bridge SOURCE, so they stay written
    // there; this pins the classifier's copy to that source, so a re-word in either place fails.
    const bridge = fs.readFileSync(path.join(__dirname, '..', 'hermes', 'hermes-bridge.service.ts'), 'utf8');
    for (const s of Object.values(CHAT_EDIT_WORDS)) {
      expect(bridge.replace(/\\'/g, "'")).toContain(s);
    }
  });

  it("BEA-1403's loud doubt is customer-actionable (a WARNING with a next step), never plumbing", () => {
    const line = doubtLine('Gmail · Fetch Emails', 6);
    expect(plumbingClassOf(line)).toBeNull();
    expect(line).toMatch(/Check the source's arguments/);
  });

  it("BEA-1393's pause message already ends in \"run it the old way\" — the classifier agrees", () => {
    const words = stopWords('Nightly Email Summary', { rule: 'minRows', actionId: 'svc:gmail.fetch_emails', key: 'j|minRows|svc:gmail.fetch_emails', label: 'the rows came up short' } as any, ['Try 1']);
    for (const s of [words.reason, words.detail]) {
      expect(plumbingClassOf(s)).toBeNull();
      expect(endsInMove(s)).toBe(true);
      expect(s).toMatch(/old way/);
    }
  });
});
