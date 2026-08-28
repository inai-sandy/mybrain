import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * AN ANSWER GOES TO THE QUESTION THAT ASKED IT (BEA-1512).
 *
 * BEA-1505 made every listener hear every answer, which fixed "Keep it" — and broke something worse
 * within hours. His ESP32 program asked *"Reddit had only 84 posts, not 100 — write those, or stop?"*
 * He replied **"Write those posts"**. The GOAL listener heard it too, decided it was not "keep it",
 * and sent his words to Codex as a correction: the approved goal was replaced by a question, and the
 * sheet he had just approved was never written.
 *
 * Hearing every answer is right. ACTING on every answer is not.
 *
 * This test reads BOTH trial services, because fixing one and not the other is what turns a bug into
 * a recurring bug — the brief road had the identical flaw with only "does this run have a trial" in
 * front of it, which does not tell the two questions apart at all.
 */
describe('every answer listener acts only on its own question', () => {
  const files = {
    goal: readFileSync(join(__dirname, 'goal-trial.service.ts'), 'utf8'),
    brief: readFileSync(join(__dirname, 'brief-trial.service.ts'), 'utf8'),
  };

  for (const [road, src] of Object.entries(files)) {
    it(`the ${road} road checks the waitpoint before acting`, () => {
      expect(src).toContain('isMyQuestion');
      // The guard must be the FIRST thing onAnswer does — a check after the work is not a guard.
      const body = src.slice(src.indexOf('private async onAnswer('));
      expect(body.slice(0, 300)).toContain('isMyQuestion');
    });

    it(`the ${road} road recognises its question by its own choices, not by a remembered id`, () => {
      // An id in memory does not survive a restart, and a run can wait for days.
      expect(src).toMatch(/options\.includes\(KEEP_IT\)\s*&&\s*options\.includes\(SEND_BACK\)/);
    });

    it(`the ${road} road does nothing when it cannot tell`, () => {
      expect(src).toMatch(/if \(!waitpointId\) return false/);
    });

    it(`the ${road} road receives the waitpoint id from its registration`, () => {
      expect(src).toMatch(/setAnswerWatcher\?\.\(\([^)]*waitpointId[^)]*\)/);
    });
  }
});
