import { AgentEvents } from './agent-events.service';
import { AppEventsService } from '../events/events.service';

describe('AgentEvents — event triggers (BEA-1076)', () => {
  function harness(agents: any[]) {
    const started: any[] = [];
    const agent: any = { listAgents: jest.fn(async () => agents) };
    const bridge: any = { startRun: jest.fn(async (i: any) => { started.push(i); return { id: 'r1' }; }) };
    const events = new AppEventsService();
    const svc = new AgentEvents(agent, bridge, events);
    svc.onModuleInit();
    return { svc, events, started };
  }

  it('fires ONLY enabled agents subscribed to that event, with the trigger in the input', async () => {
    const h = harness([
      { id: 'a1', name: 'Bookmark filer', enabled: true, prompt: 'file it', schedule: { event: 'bookmark.added' }, rubric: null, collectionId: null, defaultDepth: 'quick' },
      { id: 'a2', name: 'Journal watcher', enabled: true, prompt: 'watch', schedule: { event: 'journal.added' } },
      { id: 'a3', name: 'Disabled one', enabled: false, prompt: 'x', schedule: { event: 'bookmark.added' } },
      { id: 'a4', name: 'Clock one', enabled: true, prompt: 'x', schedule: { every: 'day', at: '07:00' } },
    ]);
    h.events.emit('bookmark.added', { summary: 'A new bookmark just landed: "pgvector deep dive"' });
    await new Promise((r) => setTimeout(r, 15));
    expect(h.started).toHaveLength(1);
    expect(h.started[0].agentId).toBe('a1');
    expect(h.started[0].prompt).toContain('file it');
    expect(h.started[0].prompt).toContain('pgvector deep dive'); // the trigger data rides in the input → Replay works
    expect(h.started[0].title).toContain('new bookmark');
    expect(h.started[0].depth).toBe('quick');
  });

  it('an event with no subscribers is a quiet no-op', async () => {
    const h = harness([{ id: 'a1', name: 'X', enabled: true, prompt: 'x', schedule: { every: 'day', at: '07:00' } }]);
    h.events.emit('whatsapp.reply', { summary: 'Jayanth replied' });
    await new Promise((r) => setTimeout(r, 15));
    expect(h.started).toHaveLength(0);
  });
});
