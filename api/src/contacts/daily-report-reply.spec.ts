import { dailyReceivedLine } from './claim-reply';

/**
 * BEA-1295 — a standing report is never "done", but it must not feel ignored.
 *
 * Confirming a daily report done would kill its chase forever and tomorrow's update would never be
 * asked for. That is correct and does not change here. What changes is what the reporter hears:
 * they sent real numbers, got a generic "thanks", and the chase came back — which from their side
 * is indistinguishable from nobody reading it.
 *
 * Four people are on daily reports: Jayanth (production, OT), Karthik (Haasya production by 7PM),
 * Radha (3rd floor), Rakesh (Friday night status).
 */

describe('the "today\'s is in" line (BEA-1295)', () => {
  it('names the report, says nothing more is needed, and says when it comes round again', () => {
    const line = dailyReceivedLine(["today's production update"]);
    expect(line).toContain("today's production update");
    expect(line).toMatch(/nothing else needed today/i);
    expect(line).toMatch(/ask again tomorrow/i);
  });

  it('never says "done" — that word is the thing this must not imply', () => {
    // A reporter told "marked as done" would reasonably stop sending tomorrow's.
    const line = dailyReceivedLine(["today's production update"]);
    expect(line.toLowerCase()).not.toMatch(/\bdone\b/);
    expect(line.toLowerCase()).not.toMatch(/marked/);
    expect(line.toLowerCase()).not.toMatch(/confirm/);
  });

  it('handles both of Jayanth\'s reports in one sentence', () => {
    const line = dailyReceivedLine(["today's production update", "today's OT update"]);
    expect(line).toContain("today's production update and today's OT update");
    expect(line).toContain('are in');
  });

  it('does NOT promise tomorrow for a report with its own weekday', () => {
    // Rakesh's is Friday-only. "I'll ask again tomorrow" on a Friday is simply untrue, and a
    // number a person can check has to survive them checking it.
    const line = dailyReceivedLine(["today's production status update"], false);
    expect(line).toMatch(/next time it's due/i);
    expect(line).not.toMatch(/tomorrow/i);
  });

  it('says nothing when nothing arrived', () => {
    expect(dailyReceivedLine([])).toBe('');
    expect(dailyReceivedLine([''])).toBe('');
  });
});

// ---- through the agent, on the real outgoing message ----
function agent(voice: string, over: { tasks?: any[]; reminders?: any[]; lastIn?: string; history?: any[]; restDays?: string[]; today?: string } = {}) {
  const contact = { id: 'c1', name: 'Jayanth', whatsappNumber: '919812345678' };
  const reminders = over.reminders ?? [{ id: 'r1', status: 'active', subject: "today's production update", taskId: 't1' }];
  const tasks = over.tasks ?? [{ id: 't1', title: 'Send the daily production update', kind: 'recurring', status: 'open', scheduleDays: null }];
  const state: any = { texts: [] as any[], out: [] as any[], received: [] as any[] };
  const prisma: any = {
    contact: { findUnique: async () => contact },
    reminder: { findMany: async () => reminders, update: async () => undefined, updateMany: async () => undefined },
    reminderMessage: {
      findMany: async () => [
        ...(over.history ?? []),
        { direction: 'in', body: over.lastIn ?? 'Sir today 240 units tested, 180 packed, line ran till 6pm', createdAt: new Date() },
      ],
      create: async ({ data }: any) => state.out.push(data),
    },
    setting: { findUnique: async () => ({ value: '919885698665' }) },
    task: { findUnique: async () => null, findMany: async () => tasks },
    briefing: { findMany: async () => [] },
  };
  const postbox: any = { isConfigured: () => true, sendText: async (to: string, body: string) => { state.texts.push({ to, body }); return { wamid: 'w1' }; } };
  const { ReminderAgentService } = require('./reminder-agent.service');
  const svc = new ReminderAgentService(
    prisma,
    postbox,
    { voiceComplete: async () => voice, shareLinkFor: async () => 'https://mybrain.1site.ai/t/jayanth-w5ng' } as any,
    { claim: async () => null, isPending: async () => false } as any,
    {
      today: () => over.today ?? '2026-08-13',
      markReceived: async (id: string) => { state.received.push(id); },
      markNotReceived: async () => false,
      isReceived: async () => false,
      restDays: async () => over.restDays ?? ['Sun'],
    } as any,
    { recordPromise: async () => ({ ok: true }) } as any,
    { get: async () => '' } as any,
    { record: async () => null } as any,
    { recordClaim: async () => ({ claimed: false }) } as any,
  );
  return { svc, state };
}

describe('what the daily reporter actually receives (BEA-1295)', () => {
  const REPORT = '{"send":true,"reply":"Thanks Jayanth, 240 tested and 180 packed noted.","needsSandeep":false,"statusToday":[1]}';

  it('the sent message says today\'s is in and that it returns tomorrow', async () => {
    const { svc, state } = agent(REPORT);
    await svc.onContactReply('c1');
    expect(state.texts).toHaveLength(1);
    const body = state.texts[0].body;
    expect(body).toContain('Thanks Jayanth'); // the assistant's own engagement survives
    expect(body).toMatch(/production update/);
    expect(body).toMatch(/ask again tomorrow/i);
  });

  it('and never tells them it is done', async () => {
    const { svc, state } = agent(REPORT);
    await svc.onContactReply('c1');
    expect(state.texts[0].body).not.toMatch(/marked .* as done/i);
  });

  it('says "next time it\'s due" for a Friday-only report', async () => {
    const { svc, state } = agent(REPORT, {
      tasks: [{ id: 't1', title: 'Send Friday night production status update', kind: 'recurring', status: 'open', scheduleDays: '["Fri"]' }],
    });
    await svc.onContactReply('c1');
    expect(state.texts[0].body).toMatch(/next time it's due/i);
    expect(state.texts[0].body).not.toMatch(/ask again tomorrow/i);
  });

  it('stays quiet about it when no report arrived — a bare "ok sir" is not an update', async () => {
    // Paired with a positive control in the SAME test: an "absence" assertion on its own passes
    // just as happily when the feature does not exist at all. (review finding)
    const quiet = agent('{"send":true,"reply":"Thanks!","needsSandeep":false,"statusToday":[]}', { lastIn: 'ok sir' });
    await quiet.svc.onContactReply('c1');
    expect(quiet.state.texts[0].body).not.toMatch(/nothing else needed today/i);

    const real = agent(REPORT);
    await real.svc.onContactReply('c1');
    expect(real.state.texts[0].body).toMatch(/nothing else needed today/i); // the feature IS alive
  });

  it('stays quiet when they only PROMISE today\'s report later', async () => {
    // "will send by 8pm" is not the update. Acknowledging it as received would settle the day and
    // stop the chase for something that never arrived.
    const { svc, state } = agent('{"send":true,"reply":"Sure, thanks.","needsSandeep":false,"statusToday":[]}', { lastIn: 'sir I will send it by 8pm today' });
    await svc.onContactReply('c1');
    expect(state.texts[0].body).not.toMatch(/nothing else needed today/i);
    expect(state.received).toHaveLength(0);
  });

  it('a report closed by the "done" list gets the same line, not the completion one', async () => {
    // The model sometimes puts a daily item in `done` despite being told not to. That path settles
    // the day instead — and must acknowledge it the same way. Only the `statusToday` path was
    // covered before. (review finding)
    const { svc, state } = agent('{"send":true,"reply":"Thanks!","needsSandeep":false,"done":[1]}');
    await svc.onContactReply('c1');
    expect(state.texts[0].body).toMatch(/nothing else needed today/i);
    expect(state.texts[0].body).not.toMatch(/marked .* as done/i);
  });

  it('mixed daily + weekday-only in one message falls back to the safe wording', async () => {
    const { svc, state } = agent('{"send":true,"reply":"Thanks!","needsSandeep":false,"statusToday":[1,2]}', {
      reminders: [
        { id: 'r1', status: 'active', subject: "today's production update", taskId: 't1' },
        { id: 'r2', status: 'active', subject: "today's Friday status", taskId: 't2' },
      ],
      tasks: [
        { id: 't1', title: 'Send the daily production update', kind: 'recurring', status: 'open', scheduleDays: null },
        { id: 't2', title: 'Send Friday night production status update', kind: 'recurring', status: 'open', scheduleDays: '["Fri"]' },
      ],
    });
    await svc.onContactReply('c1');
    expect(state.texts[0].body).toMatch(/next time it's due/i); // never a false "tomorrow"
  });

  it('does not promise "tomorrow" when tomorrow is a rest day', async () => {
    // An unscheduled report is still not owed on a rest day. Saying "I'll ask again tomorrow" on a
    // Saturday, with Sunday off, is the same class of untruth the Friday-only case avoids.
    // (review finding) — 2026-08-15 is a Saturday.
    const { svc, state } = agent(REPORT, { today: '2026-08-15', restDays: ['Sun'] });
    await svc.onContactReply('c1');
    expect(state.texts[0].body).toMatch(/next time it's due/i);
    expect(state.texts[0].body).not.toMatch(/ask again tomorrow/i);
  });

  it('reaches them even when the exact wording was already sent on an EARLIER day', async () => {
    // The duplicate guard compares against the last 30 messages, which can span weeks, and this
    // line carries no date. Without a today-scoped exemption the reporter hears nothing on the very
    // day they sent their numbers — the bug this ticket exists to fix. (review finding)
    const bodyLastWeek = "Thanks Jayanth, 240 tested and 180 packed noted.\n\n✅ Got it — today's production update is in. Nothing else needed today; I'll ask again tomorrow.";
    const { svc, state } = agent(REPORT, {
      history: [{ direction: 'out', body: bodyLastWeek, createdAt: new Date(Date.now() - 7 * 86400000) }],
    });
    await svc.onContactReply('c1');
    expect(state.texts).toHaveLength(1);
    expect(state.texts[0].body).toMatch(/nothing else needed today/i);
  });

  it('but is still not repeated twice in one day', async () => {
    const bodyToday = "Thanks Jayanth, 240 tested and 180 packed noted.\n\n✅ Got it — today's production update is in. Nothing else needed today; I'll ask again tomorrow.";
    const { svc, state } = agent(REPORT, { history: [{ direction: 'out', body: bodyToday, createdAt: new Date() }] });
    await svc.onContactReply('c1');
    expect(state.texts).toHaveLength(0);
  });
});
