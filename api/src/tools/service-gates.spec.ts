import { isRiskyAction } from './service-provider';
import { GatePause, ServiceGatesService } from './service-gates.service';
import { ServiceActionsService } from './service-actions.service';

/**
 * BEA-1348 — the gate: actions that cannot be undone stop and ask.
 *
 * The property that matters most here is NOT "does it stop the dangerous one". It is **does it let
 * everything else through**. The owner chose full access with gates expecting to see one "maybe
 * once a week, so I'll actually read it"; a gate on every other step is a gate nobody reads. So
 * these tests spend as much effort on what must NOT pause as on what must.
 */

describe('what is gated, and — just as important — what is not (BEA-1348)', () => {
  const gated = (slug: string) => isRiskyAction(slug, slug.split('_')[0].toLowerCase());

  it('gates every rule pattern from the spec', () => {
    const bySlug = [
      'GITHUB_DELETE_A_REPOSITORY',
      'GITHUB_REMOVE_AN_ORGANIZATION_MEMBER',
      'GITHUB_MERGE_A_PULL_REQUEST',
      'NOTION_ARCHIVE_NOTION_PAGE',
      'GITHUB_REVOKE_AN_INSTALLATION_ACCESS_TOKEN',
      'GITHUB_TRANSFER_A_REPOSITORY',
      'STRIPE_CREATE_REFUND',
      'STRIPE_CANCEL_SUBSCRIPTION',
      'GITHUB_BLOCK_A_USER',
      'SLACK_INVITE_USER_TO_WORKSPACE',
      'GITHUB_ADD_A_REPOSITORY_COLLABORATOR',
      'GITHUB_ASSIGN_AN_ORGANIZATION_ROLE_TO_A_USER',
      'GITHUB_SET_GITHUB_ACTIONS_PERMISSIONS_FOR_A_REPOSITORY',
    ];
    for (const slug of bySlug) expect([slug, gated(slug)]).toEqual([slug, true]);
    // …and by our own id, which is the shape the gate actually sees at run time.
    expect(isRiskyAction('svc:github.delete_a_repository')).toBe(true);
  });

  it('gates the ones the rules miss, from the hand-kept list', () => {
    expect(gated('GITHUB_RESET_A_TOKEN')).toBe(true);              // the old token stops working
    expect(gated('STRIPE_CONFIRM_PAYMENT_INTENT')).toBe(true);     // real money leaves
    expect(gated('SLACK_DELETES_A_MESSAGE_FROM_A_CHAT')).toBe(true); // "DELETES", not "DELETE_"
  });

  it('NEVER gates a normal write — this is the whole bargain', () => {
    const free = [
      'GITHUB_CREATE_AN_ISSUE',
      'GITHUB_CREATE_AN_ISSUE_COMMENT',
      'GITHUB_CREATE_A_PULL_REQUEST',
      'GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS',
      'GITHUB_UPDATE_A_REFERENCE',
      'GITHUB_ADD_LABELS_TO_AN_ISSUE',
      'GITHUB_ADD_ASSIGNEES_TO_AN_ISSUE',
      'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL',
      'LINEAR_CREATE_LINEAR_ISSUE',
      'GMAIL_SEND_EMAIL',
    ];
    for (const slug of free) expect([slug, gated(slug)]).toEqual([slug, false]);
  });

  it('NEVER gates a read, even when its name is full of frightening words', () => {
    const reads = [
      'GITHUB_LIST_REPOSITORY_COLLABORATORS',
      'GITHUB_REPO_S_LIST_COLLABORATORS',
      'GITHUB_GET_AN_ORGANIZATION_ROLE',
      'GITHUB_CHECK_IF_A_USER_IS_BLOCKED_BY_AN_ORGANIZATION',
      'GITHUB_VERIFY_DEV_CONTAINER_PERMISSIONS_ACCEPTED',
      'GITHUB_LIST_DELETED_PACKAGES',
      'STRIPE_LIST_REFUNDS',
    ];
    for (const slug of reads) expect([slug, gated(slug)]).toEqual([slug, false]);
  });

  it('does not gate the false positives — taking a label off is not "cannot be undone"', () => {
    const reversible = [
      'GITHUB_REMOVE_A_LABEL_FROM_AN_ISSUE',
      'GITHUB_REMOVE_ALL_LABELS_FROM_AN_ISSUE',
      'GMAIL_REMOVE_LABEL',
      'LINEAR_REMOVE_ISSUE_LABEL',
      'GITHUB_REMOVE_ASSIGNEES_FROM_AN_ISSUE',
      'GITHUB_REMOVE_REQUESTED_REVIEWERS_FROM_A_PULL_REQUEST',
      'GITHUB_DELETE_AN_ISSUE_REACTION',
      'SLACK_REMOVE_REACTION_FROM_ITEM',
      'SLACK_REMOVE_A_STAR_FROM_AN_ITEM',
    ];
    for (const slug of reversible) expect([slug, gated(slug)]).toEqual([slug, false]);
  });

  /**
   * The "a read is never gated" rule reads the FIRST word only, which is safe exactly as long as
   * every action slug is `<VERB>_<the rest>`. This is that assumption, written down: if a provider
   * ever ships a slug whose real verb is not its first word, this test is where it shows up.
   */
  it('trusts the first word to BE the verb — and still gates when a destructive verb leads', () => {
    expect(gated('GITHUB_DELETE_A_LIST')).toBe(true);      // "LIST" later in the name changes nothing
    expect(gated('GITHUB_LIST_DELETED_PACKAGES')).toBe(false); // and a read that mentions deleting does not
  });

  it('keeps gating the real thing even when a soft word is in the same name', () => {
    // "remove the collaborator" is not "remove the label", however similar the shape.
    expect(gated('GITHUB_REMOVE_A_REPOSITORY_COLLABORATOR')).toBe(true);
    expect(gated('GITHUB_REMOVE_CUSTOM_LABEL_FROM_REPO_RUNNER')).toBe(false);
  });

  /**
   * The measure the owner actually set: he should see a gate about once a week. This is the real
   * shortlist the catalog is built from — the 36 GitHub actions an agent can pick today (read from
   * the live API on 2026-08-16) — and only two of them may stop and ask.
   */
  it('leaves 34 of the 36 GitHub actions an agent can actually pick running free', () => {
    const shipped = [
      'GITHUB_ADD_AN_EMAIL_ADDRESS_FOR_THE_AUTHENTICATED_USER', 'GITHUB_ADD_A_REPOSITORY_COLLABORATOR',
      'GITHUB_ADD_ASSIGNEES_TO_AN_ISSUE', 'GITHUB_ADD_LABELS_TO_AN_ISSUE',
      'GITHUB_APPROVE_A_WORKFLOW_RUN_FOR_A_FORK_PULL_REQUEST', 'GITHUB_COMPARE_TWO_COMMITS',
      'GITHUB_CREATE_A_BLOB', 'GITHUB_CREATE_A_COMMIT', 'GITHUB_CREATE_AN_ISSUE',
      'GITHUB_CREATE_AN_ISSUE_COMMENT', 'GITHUB_CREATE_AN_ORGANIZATION_REPOSITORY',
      'GITHUB_CREATE_A_PULL_REQUEST', 'GITHUB_CREATE_A_REFERENCE', 'GITHUB_CREATE_A_RELEASE',
      'GITHUB_CREATE_A_TREE', 'GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS', 'GITHUB_DELETE_A_REPOSITORY',
      'GITHUB_FIND_PULL_REQUESTS', 'GITHUB_FIND_REPOSITORIES', 'GITHUB_GET_A_PULL_REQUEST',
      'GITHUB_GET_A_REFERENCE', 'GITHUB_GET_REPOSITORY_CONTENT', 'GITHUB_LIST_BRANCHES',
      'GITHUB_LIST_DEPLOYMENTS', 'GITHUB_LIST_ORGANIZATIONS_FOR_A_USER',
      'GITHUB_LIST_ORGANIZATIONS_FOR_THE_AUTHENTICATED_USER', 'GITHUB_LIST_PULL_REQUESTS',
      'GITHUB_LIST_PULL_REQUESTS_FILES', 'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER',
      'GITHUB_LIST_REPOSITORIES_STARRED_BY_THE_AUTHENTICATED_USER', 'GITHUB_LIST_REPOSITORY_CONTRIBUTORS',
      'GITHUB_LIST_REPOSITORY_ISSUES', 'GITHUB_LIST_STARGAZERS', 'GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS',
      'GITHUB_STAR_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER', 'GITHUB_UPDATE_A_REFERENCE',
    ];
    expect(shipped).toHaveLength(36);
    expect(shipped.filter(gated)).toEqual(['GITHUB_ADD_A_REPOSITORY_COLLABORATOR', 'GITHUB_DELETE_A_REPOSITORY']);
  });
});

// ---- the question, and the answer -----------------------------------------------------------

describe('the question names the real consequence, with the real target (BEA-1348)', () => {
  const gates = new ServiceGatesService();

  it('says what will happen, to what, and that it cannot be undone', () => {
    const gate = gates.build({
      action: { id: 'svc:github.delete_a_branch', name: 'Delete a branch', description: '', schema: {}, risky: true, service: 'github' },
      actionId: 'svc:github.delete_a_branch',
      service: 'github',
      serviceName: 'GitHub',
      args: { owner: 'inai-sandy', repo: 'mybrain', branch: 'feature/x' },
      accountLabel: 'sandy on GitHub',
      label: 'Tidy up old branches',
      stepInput: 'The prototype branches from June are finished with.',
    });
    expect(gate.question).toContain('Delete a branch on GitHub — inai-sandy/mybrain?');
    expect(gate.question).toContain('This cannot be undone.');
    expect(gate.question).toContain('branch = feature/x');           // the REAL target, not a summary
    expect(gate.question).toContain('Tidy up old branches');          // what the agent was trying to do
    expect(gate.question).toContain('sandy on GitHub');
    expect(gate.question).not.toMatch(/allow this action/i);
  });

  it('never writes a secret into the question', () => {
    const gate = gates.build({
      action: { id: 'svc:github.delete_a_secret', name: 'Delete a secret', description: '', schema: {}, risky: true, service: 'github' },
      actionId: 'svc:github.delete_a_secret',
      service: 'github',
      serviceName: 'GitHub',
      args: { name: 'DEPLOY', api_key: 'sk-live-123' },
    });
    expect(gate.question).toContain('DEPLOY');
    expect(gate.question).not.toContain('sk-live-123');
  });

  it('treats anything that is not plainly a yes as a no', () => {
    for (const yes of ['Yes, run it', 'yes', 'y', 'ok', 'go ahead', 'approve', 'do it']) expect([yes, gates.readDecision(yes)]).toEqual([yes, 'approved']);
    for (const no of ['No, stop', 'no', 'stop', 'not sure', '', 'maybe later', 'hmm']) expect([no, gates.readDecision(no)]).toEqual([no, 'rejected']);
  });
});

// ---- the pause itself -------------------------------------------------------------------------

const DELETE_ACTION = {
  id: 'svc:github.delete_a_repository',
  name: 'Delete a repository',
  description: 'Deletes a repository for good.',
  service: 'github',
  risky: true,
  schema: { type: 'object', required: ['owner', 'repo'], properties: { owner: { type: 'string' }, repo: { type: 'string' } } },
};
const SAFE_ACTION = { ...DELETE_ACTION, id: 'svc:github.create_an_issue', name: 'Create an issue', risky: false, schema: { type: 'object', required: ['owner', 'repo'], properties: { owner: { type: 'string' }, repo: { type: 'string' } } } };

function harness(opts: { action?: any; gateRows?: any[] } = {}) {
  const calls: any[] = [];
  const gateRows: any[] = opts.gateRows || [];
  const prisma: any = {
    toolCall: { create: async ({ data }: any) => { calls.push(data); return data; } },
    serviceGate: {
      findFirst: async ({ where }: any) => gateRows.find((r) => Object.entries(where).every(([k, v]) => (v === null ? r[k] == null : r[k] === v))) || null,
      findMany: async () => gateRows,
      create: async ({ data }: any) => { const row = { id: `g${gateRows.length + 1}`, usedAt: null, ...data }; gateRows.push(row); return row; },
      update: async ({ where, data }: any) => { const r = gateRows.find((x) => x.id === where.id); if (r) Object.assign(r, data); return r; },
      deleteMany: async ({ where }: any) => { for (let i = gateRows.length - 1; i >= 0; i--) if (gateRows[i].action === where.action && gateRows[i].scope === where.scope) gateRows.splice(i, 1); return { count: 1 }; },
    },
  };
  const provider: any = {
    getService: async () => ({ slug: 'github', name: 'GitHub', accounts: [{ id: 'ca_1', label: 'sandy on GitHub', status: 'ACTIVE' }] }),
    getAction: async () => opts.action || DELETE_ACTION,
    execute: jest.fn(async () => ({ ok: true, data: { ok: true }, ms: 30 })),
    refresh: jest.fn(),
  };
  const llm: any = { completeHelper: jest.fn(async () => '{"owner":"inai-sandy","repo":"mybrain"}'), complete: jest.fn(async () => 'INVENTED') };
  const gates = new ServiceGatesService(prisma, provider);
  return { svc: new ServiceActionsService(provider, llm, prisma, gates), calls, provider, llm, gates, gateRows, prisma };
}

describe('a gated action stops BEFORE the provider is called (BEA-1348)', () => {
  it('throws a durable pause, and the provider is never reached', async () => {
    const { svc, provider } = harness();
    const err = await svc.run('svc:github.delete_a_repository', 'clean up the old prototypes', { runId: 'run1', runKind: 'flow', nodeId: 'n1', label: 'Tidy up' }).catch((e) => e);

    expect(err).toBeInstanceOf(GatePause);
    expect(err.gate.question).toContain('Delete a repository on GitHub — inai-sandy/mybrain?');
    expect(err.gate.args).toEqual({ owner: 'inai-sandy', repo: 'mybrain' });
    // The guarantee. Nothing was sent, so no dangerous action has to be run to prove a gate works.
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('writes the ToolCall row BEFORE it pauses, so a run killed mid-pause still shows the attempt', async () => {
    const { svc, calls, provider } = harness();
    await svc.run('svc:github.delete_a_repository', 'clean up', { runId: 'run1', nodeId: 'n1' }).catch(() => undefined);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ gated: true, ok: false, action: 'svc:github.delete_a_repository', runId: 'run1', nodeId: 'n1' });
    expect(calls[0].error).toMatch(/approval/i);
    expect(JSON.parse(calls[0].arguments)).toEqual({ owner: 'inai-sandy', repo: 'mybrain' });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('a normal write never pauses', async () => {
    const { svc, provider, calls } = harness({ action: SAFE_ACTION });
    await svc.run('svc:github.create_an_issue', 'file a bug', { runId: 'run1', nodeId: 'n1' });
    expect(provider.execute).toHaveBeenCalled();
    expect(calls[0]).toMatchObject({ ok: true, gated: false });
  });

  it('runs a gated action once the owner has said yes — with the ARGUMENTS HE SAW, not fresh ones', async () => {
    const { svc, provider, llm, gates, calls } = harness();
    const err = await svc.run('svc:github.delete_a_repository', 'clean up', { runId: 'run1', nodeId: 'n1' }).catch((e) => e);
    await svc.answerGate(err.gate, 'Yes, run it', { runId: 'run1', nodeId: 'n1' });

    llm.completeHelper.mockResolvedValue('{"owner":"someone-else","repo":"a-different-repo"}');
    const out = await svc.run('svc:github.delete_a_repository', 'clean up', { runId: 'run1', nodeId: 'n1' });

    expect(out).toContain('GitHub: Delete a repository');
    // The approved arguments, not whatever a second model call would have guessed.
    expect(provider.execute).toHaveBeenCalledWith('svc:github.delete_a_repository', { owner: 'inai-sandy', repo: 'mybrain' }, { connectionId: 'ca_1' });
    expect(calls[calls.length - 1]).toMatchObject({ ok: true, gated: true });
    // And the yes is spent — it cannot approve a second run of the same step.
    expect(await gates.approvalFor('svc:github.delete_a_repository', { runId: 'run1', nodeId: 'n1' })).toBeNull();
  });

  it('runs nothing when the owner says no, and says so plainly', async () => {
    const { svc, provider, calls } = harness();
    const err = await svc.run('svc:github.delete_a_repository', 'clean up', { runId: 'run1', nodeId: 'n1' }).catch((e) => e);
    const d = await svc.answerGate(err.gate, 'No, stop', { runId: 'run1', nodeId: 'n1' });

    expect(d.approved).toBe(false);
    expect(d.message).toContain('You said no');
    expect(d.message).toContain('Delete a repository on GitHub — inai-sandy/mybrain');
    expect(provider.execute).not.toHaveBeenCalled();
    expect(calls[calls.length - 1]).toMatchObject({ gated: true, ok: false });
  });

  it('stops asking once the action is released permanently', async () => {
    const { svc, provider, gates, calls } = harness();
    await gates.release('svc:github.delete_a_repository');
    await svc.run('svc:github.delete_a_repository', 'clean up', { runId: 'run2', nodeId: 'n1' });
    expect(provider.execute).toHaveBeenCalled();
    expect(calls[calls.length - 1]).toMatchObject({ ok: true, gated: false });

    // …and asks again the moment the owner puts the gate back.
    await gates.restore('svc:github.delete_a_repository');
    await expect(svc.run('svc:github.delete_a_repository', 'clean up', { runId: 'run3', nodeId: 'n2' })).rejects.toBeInstanceOf(GatePause);
  });

  it('an approval belongs to ONE step of ONE run — never to tomorrow\'s run', async () => {
    const { svc, provider } = harness();
    const err = await svc.run('svc:github.delete_a_repository', 'clean up', { runId: 'run1', nodeId: 'n1' }).catch((e) => e);
    await svc.answerGate(err.gate, 'yes', { runId: 'run1', nodeId: 'n1' });
    await expect(svc.run('svc:github.delete_a_repository', 'clean up', { runId: 'run9', nodeId: 'n1' })).rejects.toBeInstanceOf(GatePause);
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('stops even if the provider forgot to flag the action, and even with no database', async () => {
    const { svc, provider } = harness({ action: { ...DELETE_ACTION, risky: false } });
    await expect(svc.run('svc:github.delete_a_repository', 'clean up', {})).rejects.toBeInstanceOf(GatePause);
    expect(provider.execute).not.toHaveBeenCalled();

    // A harness built without prisma at all still fails CLOSED — no release can be found, so it asks.
    const bare = new ServiceActionsService(
      { getService: async () => ({ slug: 'github', name: 'GitHub', accounts: [{ id: 'c', label: 'a', status: 'ACTIVE' }] }), getAction: async () => DELETE_ACTION, execute: jest.fn(), refresh: () => undefined } as any,
      { completeHelper: async () => '{"owner":"o","repo":"r"}' } as any,
    );
    await expect(bare.run('svc:github.delete_a_repository', 'clean up', {})).rejects.toBeInstanceOf(GatePause);
  });

  it('lists a service\'s gated actions for /tools, and marks the released ones', async () => {
    const { gates, provider } = harness();
    provider.listActions = async () => [DELETE_ACTION, SAFE_ACTION, { ...DELETE_ACTION, id: 'svc:github.merge_a_pull_request', name: 'Merge a pull request', risky: true }];
    let list = await gates.listForService('github');
    expect(list.actions.map((a) => a.id)).toEqual(['svc:github.delete_a_repository', 'svc:github.merge_a_pull_request']); // the safe one is not offered
    expect(list.actions.every((a) => !a.released)).toBe(true);

    await gates.release('svc:github.merge_a_pull_request');
    list = await gates.listForService('github');
    expect(list.actions.find((a) => a.id === 'svc:github.merge_a_pull_request')!.released).toBe(true);
  });

  /** The gate list is computed over the FULL action set (BEA-1354) — never a shortlist, never a cap. */
  it('computes the gates over every action of the service, not a shortlist of 60', async () => {
    const { gates, provider } = harness();
    const asked: any[] = [];
    provider.listActions = async (_s: string, opts: any) => {
      asked.push(opts);
      return Array.from({ length: 800 }, (_, i) => ({
        ...DELETE_ACTION, id: `svc:github.thing_${i}`, name: `Thing ${i}`, risky: i % 10 === 0,
      }));
    };
    const list = await gates.listForService('github');
    expect(asked[0]?.important).toBeUndefined();
    expect(asked[0]?.limit).toBeUndefined();
    expect(list.actions.length).toBe(80); // every risky one across all 800, well past the old 60 cap
  });
});
