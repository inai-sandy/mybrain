import { describe, expect, it } from 'vitest';
import { agentKind, hasProgram, kindLook, toolIdsOf } from './agentKind';

/**
 * TOOLS OR RESEARCH (BEA-1504).
 *
 * The owner: *"we have to formulate a plan for how we have to segregate research agents and the tools
 * agents."* Until now nothing said which was which — his goal-built email agent wore the badge
 * "chat", the same one his research agent wore.
 *
 * These cases are his REAL twelve agents, so the rule is checked against what actually exists rather
 * than against invented shapes.
 */
describe('which kind an agent is', () => {
  it('a goal-built agent is a tools agent, even though its tool list is empty', () => {
    // The one that matters most and is easiest to get wrong: a goal-built job stores `tools: []`
    // because its program decides what to call at run time. Reading the tool list alone would call
    // his email agent "research".
    expect(agentKind({ origin: 'goal', tools: [] })).toBe('tools');
    expect(agentKind({ origin: 'goal', tools: '[]' })).toBe('tools');
  });

  it('anything naming a connected account is a tools agent', () => {
    expect(agentKind({ origin: 'chat', tools: ['svc:gmail.fetch_emails'] })).toBe('tools');
    expect(agentKind({ origin: 'social', tools: ['svc:instagram.profile'] })).toBe('tools');
  });

  it('a Social agent with pinned arguments is a tools agent', () => {
    expect(agentKind({ origin: 'social', tools: [], toolArgs: { 'svc:instagram.profile': { u: 1 } } })).toBe('tools');
  });

  it('an agent that only reads the web is a research agent', () => {
    expect(agentKind({ origin: 'chat', tools: ['web_search', 'web_read', 'save_document'] })).toBe('research');
    expect(agentKind({ origin: 'voice', tools: ['web_search', 'save_document'] })).toBe('research');
  });

  it('an agent with nothing at all is research — naming no account means it thinks', () => {
    expect(agentKind({ origin: 'chat', tools: [] })).toBe('research');
    expect(agentKind(null)).toBe('research');
    expect(agentKind(undefined)).toBe('research');
  });

  it('a connected account beats a research tool when both are present', () => {
    // "search the web, then put it in my sheet" is a tools agent: it touches his account.
    expect(agentKind({ origin: 'chat', tools: ['web_search', 'svc:googlesheets.batch_update'] })).toBe('tools');
  });

  it('only a tools agent has a program', () => {
    expect(hasProgram({ origin: 'goal', tools: [] })).toBe(true);
    expect(hasProgram({ origin: 'chat', tools: ['web_search'] })).toBe(false);
  });
});

describe('reading the tool list however it was stored', () => {
  it('takes an array, a JSON string, or nothing', () => {
    expect(toolIdsOf({ tools: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(toolIdsOf({ tools: '["a"]' })).toEqual(['a']);
    expect(toolIdsOf({ tools: '' })).toEqual([]);
    expect(toolIdsOf({})).toEqual([]);
  });

  it('does not throw on a tool list that is not valid JSON', () => {
    expect(toolIdsOf({ tools: '{not json' })).toEqual([]);
  });
});

describe('how each kind reads on screen', () => {
  it('says what it is, in words, not just a colour', () => {
    const t = kindLook({ origin: 'goal', tools: [] });
    expect(t.label).toContain('tools');
    expect(t.title).toContain('your accounts');

    const r = kindLook({ origin: 'chat', tools: ['web_search'] });
    expect(r.label).toContain('research');
    expect(r.title).toContain('web');
  });

  it('carries a dark-mode class, because half his use is at night', () => {
    for (const a of [{ origin: 'goal' }, { origin: 'chat', tools: ['web_search'] }]) {
      expect(kindLook(a).cls).toContain('dark:');
    }
  });
});
