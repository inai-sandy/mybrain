import { LlmService } from './llm.service';

/**
 * BEA-1244 — the splitter runs on Sonnet 5 via the API, pinned.
 *
 * The owner: "picking the right tools is one of the most important steps in the overall process."
 * The split decides how a request is divided, what tool each branch uses and how deep it goes
 * (BEA-1246) — everything downstream inherits its judgement. It is a short thinking job, so it must
 * never wait behind engine quota nor pay the ~25,000-token system-prompt tax of a CLI turn. The
 * engine's job starts AFTER the split: collect, merge, summarise, deliver.
 */
describe('the splitter is pinned to Sonnet 5 on the API (BEA-1244)', () => {
  it('flow-plan does not follow the engine', () => {
    expect(LlmService.HELPERS['flow-plan']).not.toEqual(LlmService.FOLLOW_ENGINE);
  });

  it('flow-plan is a named API model — Sonnet 5 via OpenRouter', () => {
    expect(LlmService.HELPERS['flow-plan']).toEqual({ provider: 'openrouter', model: 'anthropic/claude-sonnet-5' });
  });

  it('the split and the question-split agree on staying off the engine', () => {
    // flow-decompose (BEA-1248) went to Haiku for the same reason. Neither half of "divide the
    // work" may quietly move back onto a CLI turn.
    expect(LlmService.HELPERS['flow-decompose']).not.toEqual(LlmService.FOLLOW_ENGINE);
  });

  it('the ENGINE keeps the delivery jobs — merge and node thinking still follow it', () => {
    // The owner's split of labour: Sonnet 5 decides, Codex does. If these move off the engine the
    // flat-rate plan stops paying for the heavy work.
    expect(LlmService.HELPERS['flow-merge']).toEqual(LlmService.FOLLOW_ENGINE);
    expect(LlmService.HELPERS['flow-node']).toEqual(LlmService.FOLLOW_ENGINE);
    expect(LlmService.HELPERS['deep-research-write']).toEqual(LlmService.FOLLOW_ENGINE);
  });
});
