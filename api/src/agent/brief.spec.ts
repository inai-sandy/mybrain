import { describe, expect, it, beforeEach } from '@jest/globals';
import { BriefService, sawText } from './brief.service';
import { SECTION_KEYS, emptyDelivery, emptySections, forCodexPayload, line, readSections, whyNotApprovable } from './brief';

/**
 * The four rules, and the two things the owner lost nine hours to (BEA-1405).
 *
 * These are not "does the code run" tests. Each one is a specific way the old builder could hand him
 * an agent that could not possibly do what he asked, with nothing anywhere saying so.
 */

// ---- a tiny in-memory store, shaped like the Prisma calls the service really makes ---------------

function store() {
  const rows: any[] = [];
  const calls: any[] = [];
  let n = 0;
  return {
    rows,
    calls,
    prisma: {
      agentBrief: {
        create: async ({ data }: any) => {
          const row = { id: `b${++n}`, approvedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
          rows.push(row);
          return row;
        },
        update: async ({ where, data }: any) => {
          const row = rows.find((r) => r.id === where.id);
          Object.assign(row, data, { updatedAt: new Date() });
          return row;
        },
        findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) || null,
        findFirst: async ({ where, orderBy }: any) => {
          const found = rows.filter((r) => r.areaId === where.areaId && (!where.status || r.status === where.status));
          return found.sort((a, b) => b.version - a.version)[0] || null;
        },
      },
      toolCall: {
        findMany: async ({ where }: any) => calls.filter((c) => where.id.in.includes(c.id)).map((c) => ({ id: c.id })),
      },
    } as any,
  };
}

const OWNER_WANT = 'Read all my important emails since yesterday and WhatsApp me a summary grouped into work, personal and finance.';

async function usable(svc: BriefService, s: ReturnType<typeof store>, areaId = 'a1') {
  s.calls.push({ id: 'call-1' });
  const b = await svc.draft(areaId, 'Nightly email summary');
  await svc.addLine(b.id, 'want', OWNER_WANT, 'owner');
  await svc.addLine(b.id, 'success', 'At least 20 mails read, all three groups, under 15 lines.', 'owner');
  await svc.noteSource(b.id, {
    id: 'svc:gmail.fetch_emails',
    actionId: 'svc:gmail.fetch_emails',
    args: { query: 'newer_than:1d' },
    evidence: { callId: 'call-1', actionId: 'svc:gmail.fetch_emails' },
    saw: 'I looked at Gmail · fetch emails and got 47 things.',
  });
  await svc.update(b.id, { delivery: { whatsapp: true, telegram: false, messageText: 'Last night · 31 mails\nWork (14) — …' } });
  return b.id;
}

describe('the brief', () => {
  let s: ReturnType<typeof store>;
  let svc: BriefService;
  beforeEach(() => {
    s = store();
    svc = new BriefService(s.prisma);
  });

  it('approves when all four rules are met', async () => {
    const id = await usable(svc, s);
    const out = await svc.approve(id);
    expect(out.ok).toBe(true);
    expect(out.brief?.status).toBe('approved');
  });

  // ---- rule 2: look before you plan ------------------------------------------------------------

  it('refuses a source nobody has actually looked at, and names it in plain English', async () => {
    const id = await usable(svc, s);
    // The same source, but the proof is a made-up id — exactly what a model writing prose produces.
    const b = await svc.get(id);
    await svc.update(b!.id, { sources: [{ ...b!.sources[0], evidence: { callId: 'not-a-real-call' } }] });
    const out = await svc.approve(id);
    expect(out.ok).toBe(false);
    const why = out.refusals!.map((r) => r.why).join(' ');
    expect(why).toContain('have not looked at');
    expect(why).toContain('Gmail');
    // Plain English: no ids, no jargon, in the words he would use.
    expect(why).not.toContain('svc:');
    expect(out.refusals![0].section).toBe('sources');
  });

  it('refuses a brief with no source at all', async () => {
    const b = await svc.draft('a2');
    await svc.addLine(b.id, 'want', OWNER_WANT, 'owner');
    await svc.addLine(b.id, 'success', 'Twenty mails.', 'owner');
    const out = await svc.approve(b.id);
    expect(out.ok).toBe(false);
    expect(out.refusals!.some((r) => r.section === 'sources')).toBe(true);
  });

  // ---- rule 3: the message he actually asked for ------------------------------------------------

  it('refuses to approve a WhatsApp agent whose message was never written down', async () => {
    // THE nine-hour bug: the plan said notify:whatsapp=true, which could only ever send
    // "finished · 5 rows saved to Documents". The format he was shown lived nowhere.
    const id = await usable(svc, s);
    await svc.update(id, { delivery: { whatsapp: true, telegram: false, messageText: '   ' } });
    const out = await svc.approve(id);
    expect(out.ok).toBe(false);
    const r = out.refusals!.find((x) => x.section === 'output')!;
    expect(r.why).toContain('what the WhatsApp message should say');
  });

  it('does not ask for a message when nothing is being sent', async () => {
    const id = await usable(svc, s);
    await svc.update(id, { delivery: { whatsapp: false, telegram: false, messageText: '' } });
    const out = await svc.approve(id);
    expect(out.ok).toBe(true);
  });

  // ---- rule 4: "it worked" has to mean something -------------------------------------------------

  it('refuses a brief that never says what a good run looks like', async () => {
    const id = await usable(svc, s);
    const b = await svc.get(id);
    await svc.update(b!.id, { sections: { ...b!.sections, success: [] } });
    const out = await svc.approve(id);
    expect(out.ok).toBe(false);
    expect(out.refusals!.some((r) => r.section === 'success')).toBe(true);
  });

  // ---- rule 1: his words, not the AI's ------------------------------------------------------------

  it('refuses a brief made entirely of the AI\'s guesses', async () => {
    const b = await svc.draft('a3');
    await svc.addLine(b.id, 'want', 'Summarise the inbox nightly.', 'ai');
    const out = await svc.approve(b.id);
    expect(out.ok).toBe(false);
    expect(out.refusals!.some((r) => r.section === 'want')).toBe(true);
  });

  // ---- striking: kept, marked, never deleted -----------------------------------------------------

  it('keeps a struck line, marks it, and moves it into Killed', async () => {
    const id = await usable(svc, s);
    await svc.addTurns(id, [{ who: 'ai', text: 'I could also post it to Telegram.' }]);
    const withLine = await svc.addLine(id, 'output', 'I could also post it to Telegram.', 'ai');
    const target = withLine.sections.output.find((l) => l.text.includes('Telegram'))!;
    const after = await svc.strike(withLine.id, target.id);

    const stillThere = after.sections.output.find((l) => l.id === target.id);
    expect(stillThere).toBeTruthy();
    expect(stillThere!.struck).toBe(true);
    expect(after.sections.killed.some((l) => l.id === target.id)).toBe(true);
    // And the turn it came from is marked too — Codex reads the transcript, not just the brief.
    expect(after.transcript.find((t) => t.text.includes('Telegram'))!.struck).toBe(true);
  });

  it('striking one line does not mark the whole conversation, and un-striking does not un-kill the rest', async () => {
    // Found in review: the first version marked EVERY turn on an un-strike, and left a matching turn
    // marked on the way back. A brief that quietly un-kills things is worse than no brief.
    const id = await usable(svc, s);
    await svc.addTurns(id, [
      { who: 'ai', text: 'I could also post it to Telegram.' },
      { who: 'ai', text: 'I could also write it to a spreadsheet.' },
    ]);
    const one = await svc.addLine(id, 'output', 'I could also post it to Telegram.', 'ai');
    const two = await svc.addLine(one.id, 'output', 'I could also write it to a spreadsheet.', 'ai');
    const tg = two.sections.output.find((l) => l.text.includes('Telegram'))!;
    const sheet = two.sections.output.find((l) => l.text.includes('spreadsheet'))!;

    const bothStruck = await svc.strike((await svc.strike(two.id, tg.id)).id, sheet.id);
    expect(bothStruck.transcript.filter((t) => t.struck).length).toBe(2);

    // Bring ONE back: the other must stay killed.
    const after = await svc.strike(bothStruck.id, tg.id, false);
    expect(after.transcript.find((t) => t.text.includes('Telegram'))!.struck).toBeFalsy();
    expect(after.transcript.find((t) => t.text.includes('spreadsheet'))!.struck).toBe(true);
    expect(after.sections.killed.map((l) => l.id)).toEqual([sheet.id]);
  });

  it('a short line never marks turns it merely appears inside', async () => {
    const id = await usable(svc, s);
    await svc.addTurns(id, [{ who: 'you', text: 'No Telegram, no Slack, nothing else.' }]);
    const withLine = await svc.addLine(id, 'filter', 'No', 'ai');
    const l = withLine.sections.filter[0];
    const after = await svc.strike(withLine.id, l.id);
    expect(after.transcript.some((t) => t.struck)).toBe(false);
  });

  it('brings a struck line back', async () => {
    const id = await usable(svc, s);
    const withLine = await svc.addLine(id, 'filter', 'Skip newsletters.', 'ai');
    const l = withLine.sections.filter[0];
    const struck = await svc.strike(withLine.id, l.id);
    const back = await svc.strike(struck.id, l.id, false);
    expect(back.sections.filter[0].struck).toBeFalsy();
    expect(back.sections.killed.length).toBe(0);
  });

  it('a struck line does not satisfy a rule', async () => {
    const id = await usable(svc, s);
    const b = await svc.get(id);
    const success = b!.sections.success[0];
    await svc.strike(b!.id, success.id);
    const out = await svc.approve(id);
    expect(out.ok).toBe(false);
    expect(out.refusals!.some((r) => r.section === 'success')).toBe(true);
  });

  // ---- editing: touching a line makes it his -----------------------------------------------------

  it('an edited line becomes the owner\'s words and drops the tool\'s proof', async () => {
    const id = await usable(svc, s);
    const b = await svc.get(id);
    const toolLine = b!.sections.sources[0];
    expect(toolLine.origin).toBe('tool');
    const after = await svc.editLine(b!.id, toolLine.id, 'Gmail, only mail from people.');
    const edited = after.sections.sources.find((l) => l.id === toolLine.id)!;
    expect(edited.origin).toBe('owner');
    expect(edited.text).toBe('Gmail, only mail from people.');
    expect(edited.evidence).toBeUndefined();
  });

  // ---- what Codex gets ----------------------------------------------------------------------------

  it('hands Codex the whole conversation, marks what was killed, and says the brief decides', async () => {
    const id = await usable(svc, s);
    await svc.addTurns(id, [
      { who: 'you', text: OWNER_WANT },
      { who: 'ai', text: 'I could also post it to Telegram.' },
      { who: 'you', text: 'No Telegram.' },
    ]);
    const withLine = await svc.addLine(id, 'output', 'I could also post it to Telegram.', 'ai');
    const target = withLine.sections.output.find((l) => l.text.includes('Telegram'))!;
    await svc.strike(withLine.id, target.id);
    await svc.approve(id);

    const payload = await svc.forCodex('a1');
    expect(payload).toBeTruthy();
    // Every turn, nothing summarised — his decision, 2026-08-22.
    expect(payload!.transcript.length).toBe(3);
    expect(payload!.transcript.map((t) => t.text)).toContain('No Telegram.');
    // The killed idea is present AND marked, so nothing can rebuild it by accident.
    expect(payload!.transcript.find((t) => t.text.includes('Telegram'))!.struck).toBe(true);
    // And the rule that makes sending the whole transcript safe is stated in the payload itself.
    expect(payload!.decides).toContain('THE BRIEF WINS');
    expect(payload!.decides).toContain('Never build a struck thing');
    // The exact message rides along — the thing the eight-box form had nowhere to put.
    expect(payload!.brief.delivery.messageText).toContain('Work (14)');
  });

  it('has no payload until a brief is approved', async () => {
    const s2 = store();
    const svc2 = new BriefService(s2.prisma);
    await usable(svc2, s2, 'a9');
    expect(await svc2.forCodex('a9')).toBeNull();
  });

  // ---- versions ------------------------------------------------------------------------------------

  it('editing an approved brief starts the next version instead of rewriting it', async () => {
    const id = await usable(svc, s);
    await svc.approve(id);
    const approved = await svc.get(id);
    expect(approved!.version).toBe(1);

    await svc.addLine(id, 'filter', 'Skip receipts too.', 'owner');
    const latest = await svc.latest('a1');
    expect(latest!.version).toBe(2);
    expect(latest!.status).toBe('draft');
    // Version 1 is untouched, so a worker built from it can still say what it was built from.
    expect((await svc.get(id))!.status).toBe('approved');
    expect((await svc.get(id))!.sections.filter.length).toBe(0);
    // And the new version starts from the old one — he edits, he does not retype.
    expect(latest!.sections.want[0].text).toBe(OWNER_WANT);
  });

  it('one draft per agent — a reload cannot fork the brief in two', async () => {
    const a = await svc.draft('a4');
    const b = await svc.draft('a4');
    expect(b.id).toBe(a.id);
  });
});

describe('the pure parts', () => {
  it('reads junk out of the database without throwing', () => {
    expect(readSections(null)).toEqual(emptySections());
    expect(readSections({ want: 'not a list' }).want).toEqual([]);
    // An unknown origin is treated as the AI's guess — the safe direction. Claiming his words is worse.
    expect(readSections({ want: [{ text: 'x', origin: 'nonsense' }] }).want[0].origin).toBe('ai');
  });

  it('every section has a heading in plain words', () => {
    const payload = forCodexPayload({
      id: 'b', areaId: 'a', version: 1, status: 'approved', name: 'n',
      sections: emptySections(), sources: [], delivery: emptyDelivery(), transcript: [],
    });
    expect(payload.brief.sections.map((s) => s.key)).toEqual(SECTION_KEYS);
    expect(payload.brief.sections.find((s) => s.key === 'success')!.label).toBe('What "it worked" means');
  });

  it('a made-up proof is not a proof', () => {
    const out = whyNotApprovable(
      {
        sections: { ...emptySections(), want: [line('do a thing', 'owner')], success: [line('twenty rows', 'owner')] },
        sources: [{ id: 's', actionId: 'svc:gmail.fetch_emails', args: {}, evidence: { callId: 'made-up' } }],
        delivery: emptyDelivery(),
      },
      new Set(['a-real-one']),
    );
    expect(out.some((r) => r.section === 'sources')).toBe(true);
  });

  it('says what a look really showed, including when there is no date to filter on', () => {
    const said = sawText({ ok: true, actionId: 'svc:gmail.fetch_emails', name: 'Gmail · fetch emails', args: {}, count: 47, fields: [{ path: 'subject', kind: 'text' }, { path: 'from', kind: 'text' }] as any, hasDate: false, items: [], credits: 0, ms: 10, budget: { used: 1, calls: 3, credits: 0, maxCredits: 5 } });
    expect(said).toContain('47 things');
    expect(said).toContain('subject, from');
    expect(said).toContain('no date on it');
  });
});

/**
 * Deleting an agent must leave nothing behind (BEA-1406). `AgentBrief` has no foreign key — the same
 * hand-kept rule as `SocialWatch` and `RunJournal` — and each brief holds a whole conversation.
 */
describe('deleting an agent takes its briefs with it', () => {
  it('sweeps every brief for that agent, and nobody else\'s', async () => {
    const deleted: any[] = [];
    const prisma: any = {
      agent: { findMany: async () => [] },
      agentArea: { delete: async () => ({}) },
      setting: { delete: async () => ({}) },
      agentBrief: { deleteMany: async (a: any) => { deleted.push(a); return { count: 2 }; } },
    };
    const { AgentAreasService } = await import('./agent-areas.service');
    const svc: any = new (AgentAreasService as any)(prisma);
    await svc.remove('area-1');
    expect(deleted).toEqual([{ where: { areaId: 'area-1' } }]);
  });

  it('a store without the table does not break the delete', async () => {
    const prisma: any = {
      agent: { findMany: async () => [] },
      agentArea: { delete: async () => ({}) },
      setting: { delete: async () => ({}) },
    };
    const { AgentAreasService } = await import('./agent-areas.service');
    const svc: any = new (AgentAreasService as any)(prisma);
    await expect(svc.remove('area-1')).resolves.toEqual({ ok: true, jobsDeleted: 0 });
  });
});
