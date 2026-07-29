import { HermesBridgeService } from './hermes-bridge.service';

/**
 * BEA-1191 — only `execute()` declared the toolbox and checked for a disconnected tool. `resumeRun()`
 * built its own prompt and did neither, so a job that parked on a question came back UNRESTRICTED
 * once answered — on the path most likely to be used. Same shape as the task bugs: the rule lived on
 * one path and not the parallel one.
 */
function bridge(allowed: string[], catalogTools: any[]) {
  const agent: any = {
    allowedTools: async () => ({ ids: allowed, source: 'job' }),
    outcomeFor: async () => ({ rubric: '', checks: [] }),
  };
  const catalog: any = { catalog: async () => ({ groups: [], tools: catalogTools }) };
  return new HermesBridgeService(agent, {} as any, {} as any, {} as any, {} as any, {} as any, undefined, undefined, undefined, catalog);
}

const connected = [
  { id: 'web_search', name: 'Web search', description: 'the web', connected: true },
  { id: 'gmail', name: 'Gmail', description: 'email', connected: true },
];

describe('a resumed run keeps its toolbox (BEA-1191)', () => {
  it('still names exactly the picked tools, and nothing else', async () => {
    const box = await (bridge(['web_search'], connected) as any).toolbox('j1');
    expect(box.guidance).toContain('ONLY things you may use');
    expect(box.guidance).toContain('Web search');
    expect(box.guidance).not.toContain('Gmail');
    expect(box.disconnected).toEqual([]);
  });

  it('spots a tool that has been disconnected since the run parked', async () => {
    const later = [{ id: 'gmail', name: 'Gmail', description: 'email', connected: false }];
    const box = await (bridge(['gmail'], later) as any).toolbox('j1');
    expect(box.disconnected.map((t: any) => t.name)).toEqual(['Gmail']);
  });

  it('grades against the job Outcome only when there is one to grade against', async () => {
    const b: any = bridge(['web_search'], connected);
    expect(await b.gradeFor('j1', 'some result')).toBeNull(); // no rubric — the run still stands
    expect(await b.gradeFor('j1', '')).toBeNull();            // nothing produced
  });
});
