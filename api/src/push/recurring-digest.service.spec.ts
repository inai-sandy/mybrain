import { RecurringDigestService } from './recurring-digest.service';

/**
 * BEA-1121: one summary a day, only when something was actually missed, and never a repeat.
 */
function make(closed: any) {
  const sent: any[] = [];
  const recurring: any = { closeDay: async () => closed };
  const alerts: any = { dailyMissDigest: async (day: string, missed: any[]) => { sent.push({ day, missed }); return { sent: true }; } };
  return { svc: new RecurringDigestService(recurring, alerts), sent };
}

describe('the end-of-day miss summary', () => {
  it('sends one message listing everything that was missed', async () => {
    const { svc, sent } = make({ day: '2026-07-27', missed: [{ title: 'Send the OT update', contact: 'Jayanth' }] });
    expect(await svc.tick()).toEqual({ sent: true });
    expect(sent).toHaveLength(1); // ONE message, not one per item
    expect(sent[0]).toEqual({ day: '2026-07-27', missed: [{ title: 'Send the OT update', contact: 'Jayanth' }] });
  });

  it('stays silent when the day says there is nothing to report', async () => {
    const { svc, sent } = make(null);
    expect(await svc.tick()).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('still lists several misses in a single message', async () => {
    const { svc, sent } = make({ day: '2026-07-27', missed: [{ title: 'A', contact: 'Jayanth' }, { title: 'B', contact: 'Jayanth' }, { title: 'C', contact: null }] });
    await svc.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].missed).toHaveLength(3);
  });
});
