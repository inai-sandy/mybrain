import { describe, expect, it } from 'vitest';
import { subtitleOf } from './AgentApp';

/**
 * THE LINE UNDER THE NAME (BEA-1505).
 *
 * A goal-built agent's description IS the whole goal, and Codex writes goals like a person talking.
 * So the one line under his agent's name read "I will build an agent that you run manually whenever
 * you want. When it runs, it will…" — which told him nothing at all. Seen on his own screen.
 */
describe('the line under an agent name', () => {
  it('skips the preamble and uses the sentence that says what it does', () => {
    const goal =
      'I will build an agent that you run manually whenever you want. ' +
      'When it runs, it will fetch the top 100 posts from r/esp32 for the past week.';
    expect(subtitleOf(goal)).toBe('it will fetch the top 100 posts from r/esp32 for the past week.');
  });

  it('leaves a description that already says something alone', () => {
    expect(subtitleOf('Reads my Gmail every night and writes the summaries to Notion.'))
      .toBe('Reads my Gmail every night and writes the summaries to Notion.');
  });

  it('keeps the first sentence when that is all there is', () => {
    // A bad line beats a blank one.
    expect(subtitleOf('I will build an agent.')).toBe('I will build an agent.');
  });

  it('is quiet about nothing', () => {
    expect(subtitleOf('')).toBe('');
    expect(subtitleOf(null)).toBe('');
    expect(subtitleOf(undefined)).toBe('');
  });
});
