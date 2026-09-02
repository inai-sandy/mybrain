import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * BEA-1297 — "Needs you" is about a piece of work, not about a person.
 * BEA-1596 — and it has ONE home: the review inbox (`TeamUpdate.needsYou`).
 *
 * When the agent got stuck it used to set `Reminder.needsOwner` on EVERY active chase for that
 * contact — a flag the Dashboard read and the Needs you tab did not, so the two screens disagreed
 * on live data. Now the agent records an inbox row for the message it got stuck on, on the task of
 * the item the model named (or no task when it could not tell), and both screens read that row.
 */

function agent(voice: string, over: { reminders?: any[]; lastIn?: string } = {}) {
  const contact = { id: 'c1', name: 'Deepthi', whatsappNumber: '919812345678' };
  const reminders = over.reminders ?? [
    { id: 'r1', status: 'active', subject: 'the payment amount', taskId: 't1' },
    { id: 'r2', status: 'active', subject: 'the Varisters status', taskId: 't2' },
    { id: 'r3', status: 'active', subject: 'the Elleys PCBs', taskId: 't3' },
  ];
  const state: any = { texts: [] as any[], out: [] as any[], reminderWrites: [] as any[], records: [] as any[] };
  const prisma: any = {
    contact: { findUnique: async () => contact },
    reminder: {
      findMany: async () => reminders,
      update: async (args: any) => { state.reminderWrites.push(args); },
      updateMany: async (args: any) => { state.reminderWrites.push(args); return { count: 1 }; },
    },
    reminderMessage: {
      findMany: async () => [{ direction: 'in', body: over.lastIn ?? 'sir what is the budget for the Elleys order?', createdAt: new Date() }],
      create: async ({ data }: any) => state.out.push(data),
    },
    setting: { findUnique: async () => ({ value: '919885698665' }) },
    task: { findUnique: async () => null, findMany: async () => [] },
    briefing: { findMany: async () => [] },
  };
  const postbox: any = {
    isConfigured: () => true,
    sendText: async (to: string, body: string) => { state.texts.push({ to, body }); return { wamid: 'w1' }; },
    // The owner's alert is the approved template first (BEA-1362); recorded like a text so the
    // "names the work" assertion reads what he was told.
    sendTemplate: async (to: string, _name: string, vars: string[]) => { state.texts.push({ to, body: vars.join(' · '), template: true }); return { wamid: 't1', status: 'sent' }; },
  };
  const { ReminderAgentService } = require('./reminder-agent.service');
  const svc = new ReminderAgentService(
    prisma,
    postbox,
    { voiceComplete: async () => voice, shareLinkFor: async () => null } as any,
    { claim: async () => null, isPending: async () => false } as any,
    { today: () => '2026-08-13', markReceived: async () => undefined, markNotReceived: async () => false, isReceived: async () => false, restDays: async () => ['Sun'] } as any,
    { recordPromise: async () => ({ ok: true }) } as any,
    { get: async () => '' } as any,
    { record: async (input: any) => { state.records.push(input); return { id: `u${state.records.length}` }; } } as any,
    { recordClaim: async () => ({ claimed: false }) } as any,
  );
  return { svc, state };
}

/** The inbox record the agent FORCED — the one that says "needs Sandeep". */
const forced = (records: any[]) => records.find((r) => r.forceNeedsYou === true);

describe('the flag is an inbox row, on the item it is about (BEA-1297 → BEA-1596)', () => {
  it('records the message it got stuck on, against the task of the item the model named', async () => {
    const { svc, state } = agent('{"send":true,"reply":"I\'ll check with Sandeep.","needsSandeep":true,"needsItem":3}');
    await svc.onContactReply('c1');
    const row = forced(state.records);
    expect(row).toMatchObject({ contactId: 'c1', channel: 'whatsapp', taskId: 't3', text: 'sir what is the budget for the Elleys order?' });
    expect(row.why).toContain('the Elleys PCBs');
  });

  it('falls back to the whole person (no task) when the model cannot tell which', async () => {
    // Honest rather than a guess: a flag on the wrong item is worse than a vague one.
    const { svc, state } = agent('{"send":true,"reply":"I\'ll check with Sandeep.","needsSandeep":true,"needsItem":null}');
    await svc.onContactReply('c1');
    expect(forced(state.records)).toMatchObject({ contactId: 'c1', taskId: null });
  });

  it('ignores a number that matches nothing rather than flagging at random', async () => {
    const { svc, state } = agent('{"send":true,"reply":"I\'ll check.","needsSandeep":true,"needsItem":99}');
    await svc.onContactReply('c1');
    expect(forced(state.records)).toMatchObject({ contactId: 'c1', taskId: null });
  });

  it('forces nothing when the agent was not stuck — the ordinary record decides on its own', async () => {
    const { svc, state } = agent('{"send":true,"reply":"Thanks!","needsSandeep":false,"needsItem":null}', { lastIn: 'ok sir noted' });
    await svc.onContactReply('c1');
    expect(forced(state.records)).toBeUndefined();
    expect(state.records.length).toBe(1); // their words are still recorded, once
  });

  it('never writes the retired Reminder.needsOwner flag, stuck or not', async () => {
    for (const voice of ['{"send":true,"reply":"I\'ll check with Sandeep.","needsSandeep":true,"needsItem":3}', '{"send":true,"reply":"Thanks!","needsSandeep":false,"done":[1]}']) {
      const { svc, state } = agent(voice);
      await svc.onContactReply('c1');
      expect(state.reminderWrites.filter((w: any) => 'needsOwner' in (w.data || {}))).toEqual([]);
    }
  });

  it('a later cheerful message does NOT clear it — only the owner closes an inbox item (BEA-1159)', async () => {
    // The old flag was wiped by the next exchange the agent could handle; the inbox row is not.
    // Nothing in the agent touches an existing row: no reminder write, no close.
    const { svc, state } = agent('{"send":true,"reply":"Great, thanks!","needsSandeep":false,"done":[3]}', { lastIn: 'sir the Elleys PCBs are placed' });
    await svc.onContactReply('c1');
    expect(state.reminderWrites.filter((w: any) => 'needsOwner' in (w.data || {}))).toEqual([]);
    expect(state.records.every((r: any) => !r.forceNeedsYou)).toBe(true);
  });

  it('the owner\'s WhatsApp alert names the work, not just the person', async () => {
    const { svc, state } = agent('{"send":true,"reply":"I\'ll check with Sandeep.","needsSandeep":true,"needsItem":3}');
    await svc.onContactReply('c1');
    const toOwner = state.texts.find((t: any) => t.to === '919885698665');
    expect(toOwner.body).toContain('the Elleys PCBs');
  });
});

describe('the owner can see what it is about (BEA-1297)', () => {
  it('the badge sits on the row, next to that row\'s own task line, and is derived from the inbox', () => {
    const page = readFileSync(join(__dirname, '../../../web/src/pages/Contacts.tsx'), 'utf8');
    expect(page).toMatch(/rm\.needsYou &&/);
    expect(page).toMatch(/rm\.task &&.*re:/s);
  });

  it('the model is asked which item, and told not to guess', () => {
    const prompts = readFileSync(join(__dirname, '../prompts/prompts.service.ts'), 'utf8');
    expect(prompts).toContain('"needsItem"');
    expect(prompts).toMatch(/cannot tell, leave "needsItem" null rather than guessing/);
  });
});

/**
 * The retired flag is never READ or WRITTEN again (BEA-1596). A leftover reader is how the four
 * ghosts stayed on the Dashboard. Comments may still explain its history; code may not touch it.
 * The one allowed line is the strip in `RemindersService.shape()` that keeps the column from ever
 * leaving the server.
 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name === 'dist') continue;
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(spec|test)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const ALLOWED = [/needsOwner: _retired/];
function codeHits(file: string): string[] {
  const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return src
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line) && /needsOwner/.test(line.replace(/\/\/.*$/, '')))
    .filter((line) => !ALLOWED.some((ok) => ok.test(line)));
}

describe('Reminder.needsOwner is retired (BEA-1596)', () => {
  it('no api or web code reads or writes it', () => {
    const files = [...sourceFiles(join(__dirname, '..')), ...sourceFiles(join(__dirname, '../../../web/src'))];
    const hits = files.flatMap((f) => codeHits(f).map((l) => `${f.replace(/^.*\/(api|web)\//, '$1/')}: ${l.trim()}`));
    expect(hits).toEqual([]);
  });

  it('the one-off clear exists, so the live ghosts go the moment this ships', () => {
    const sql = readFileSync(join(__dirname, '../../prisma/migrations/20260902090000_needs_owner_retired/migration.sql'), 'utf8');
    expect(sql).toMatch(/UPDATE "Reminder" SET "needsOwner" = 0/);
  });
});
