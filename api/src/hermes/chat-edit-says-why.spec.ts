import * as fs from 'fs';
import * as path from 'path';

/**
 * "I couldn't work that one out" was every outcome (BEA-1575).
 *
 * His words, 2026-08-29: *"when I am trying to chat again to edit the agent, I received this
 * message. I couldn't work that one out — try saying it another way."*
 *
 * That one sentence covered four different things: the prompt template missing, the model answering
 * nothing at all (the day's AI budget, the common one), a reply that was not JSON, and a genuine "I
 * did not understand you". Only the last is something he can fix by rephrasing — and it was the only
 * one the wording described. On any of the other three he was being asked to reword a question that
 * was never the problem.
 */
const src = () => fs.readFileSync(path.join(__dirname, 'hermes-bridge.service.ts'), 'utf8');

describe('chat-to-edit says which thing went wrong', () => {
  it('names the missing prompt rather than blaming his wording', () => {
    expect(src()).toMatch(/prompt is missing in Settings/i);
  });

  // BEA-1248: a named helper returns null rather than quietly finishing on the app's general model,
  // so "nothing came back" is nearly always the budget. Rephrasing cannot help; waiting can.
  it('names the AI budget when nothing came back at all', () => {
    const s = src();
    expect(s).toMatch(/AI could not be reached/i);
    expect(s).toMatch(/budget is used up/i);
  });

  it('keeps "say it another way" only for a reply it really could not read', () => {
    expect(src()).toMatch(/not in a form I could read/i);
  });

  // Whatever the reason, nothing may be half-applied — the patch is a proposal he confirms.
  it('always says nothing was changed, whatever the reason', () => {
    const s = src();
    const edit = s.slice(s.indexOf('async chatEdit('), s.indexOf('/** "Saved by agents"'));
    // Each distinct reason, and each one telling him his agent is untouched.
    expect(edit).toMatch(/switched off/);
    expect(edit).toMatch(/budget is used up\. Nothing was changed/);
    expect(edit).toMatch(/could read\. Nothing was changed/);
  });
});
