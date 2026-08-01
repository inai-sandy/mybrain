import { AgentAreasService } from './agent-areas.service';
import { PromptsService } from '../prompts/prompts.service';

/**
 * BEA-1252 — the Research Agent's toolbox had no deep_research, so every job under it planned
 * shallow flows. A flow is planned INSIDE its job's toolbox (BEA-1174, deliberately), and jobs
 * without their own toolbox fall back to the area's. Leaving deep_research out of the area meant
 * the three-index deep research shipped in BEA-1196/1239 was unreachable from the very agent named
 * "Research". Proven live: the owner's re-planned Meshtastic flow came back web_search-only.
 */

describe('the Research Agent can actually go deep (BEA-1252)', () => {
  it('a fresh Research Agent is created WITH deep_research in its toolbox', async () => {
    let created: any = null;
    const prisma: any = {
      agentArea: {
        findMany: async () => [], // no existing Research Agent → it must create one
        create: async ({ data }: any) => { created = data; return { id: 'ar1', ...data }; },
      },
    };
    const svc = new AgentAreasService(prisma);
    const r = await svc.ensureResearchAgent();
    expect(r.created).toBe(true);
    const tools = JSON.parse(created.tools);
    const ids = tools.map((t: any) => t.id);
    expect(ids).toContain('deep_research');
    // and the rest of the standing kit is still there
    expect(ids).toEqual(expect.arrayContaining(['web_search', 'web_read', 'save_document', 'search_brain']));
  });

  it('an existing Research Agent is reused, never recreated', async () => {
    const prisma: any = {
      agentArea: {
        findMany: async () => [{ id: 'existing', name: 'Research Agent' }],
        create: async () => { throw new Error('must not create a second Research Agent'); },
      },
    };
    const svc = new AgentAreasService(prisma);
    const r = await svc.ensureResearchAgent();
    expect(r.id).toBe('existing');
    expect(r.created).toBe(false);
  });
});

describe('the EMO voice fallback kit can go deep (BEA-1252)', () => {
  it('DEFAULT_KIT includes deep_research — "full depth, no questions" must survive a picker failure', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { EmoResearchService } = require('../emo/emo-research.service');
    expect((EmoResearchService as any).DEFAULT_KIT).toContain('deep_research');
  });
});

describe('the new-job chat proposes depth for research jobs (BEA-1252)', () => {
  it('the jobBuilder prompt requires deep_research on research-style jobs', async () => {
    const prisma: any = { setting: { findUnique: async () => null, upsert: async () => ({}), deleteMany: async () => ({ count: 0 }) } };
    const tpl = await new PromptsService(prisma).get('agent.jobBuilder');
    expect(tpl).toContain('MUST include deep_research');
    expect(tpl).toContain('shallow single searches');
  });
});
