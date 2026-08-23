import { describe, expect, it } from '@jest/globals';
import { AgentFlowSyncService } from './agent-flow-sync.service';

/**
 * A brief-built agent gets NO flow planned for it (BEA-1453).
 *
 * His first real agent was created and, twenty-seven seconds later, a model he had never spoken to
 * drew it a 16-node graph — three branches running in parallel, with the Notion write racing the
 * Gmail fetch, and the daily page created by a branch that could not see the master page. No screen
 * shows him that before it runs.
 *
 * A brief-built agent runs a PROGRAM Codex wrote and tested. There is nothing left to guess at, and
 * a picture drawn by guessing is worse than no picture — because it looks like an explanation.
 */
describe('nobody plans a flow for a brief', () => {
  function svc() {
    const planned: string[] = [];
    const flows: any = {
      list: async () => { planned.push('list'); return []; },
      create: async () => { planned.push('create'); return { id: 'f1' }; },
      planAndSave: async () => { planned.push('plan'); },
    };
    const prisma: any = { flow: { update: async () => ({}) } };
    return { s: new (AgentFlowSyncService as any)(prisma, flows), planned };
  }

  it('plans nothing at all for an agent built from a brief', async () => {
    const { s, planned } = svc();
    await s.planNormal({ id: 'a1', name: 'Email digest', origin: 'brief', prompt: '1. fetch\n2. write' });
    expect(planned).toEqual([]);
  });

  it('still plans for the agents that were built the old way', async () => {
    // His nine live agents keep behaving exactly as they do. Nothing here touches them.
    const { s, planned } = svc();
    await s.planNormal({ id: 'a2', name: 'Research', origin: 'chat', prompt: '1. search' });
    expect(planned).toContain('create');
  });

  it('plans nothing when there is no task to plan from, as before', async () => {
    const { s, planned } = svc();
    await s.planNormal({ id: 'a3', name: 'Empty', origin: 'chat', prompt: '   ' });
    expect(planned).toEqual([]);
  });
});
