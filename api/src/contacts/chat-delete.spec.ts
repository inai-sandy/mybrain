import { readFileSync } from 'fs';
import { join } from 'path';
import { RemindersService } from './reminders.service';
import { TaskHealthService } from '../tasks/task-health.service';

/**
 * BEA-1309 — chats were the only thing with no delete at all.
 *
 * Of the five things the owner named — tasks, contacts, reminders, delegated work, chats — every
 * other one could be edited and removed. Chats could not: `grep reminderMessage.delete` across the
 * whole API returned nothing. Not one message, not a conversation, not ever. A message sent by
 * mistake was permanent.
 *
 * And they leaked. `contactId` was a bare column with no foreign key, and a conversation only
 * surfaces in the inbox through a live Reminder — so deleting a contact cascaded the reminders away
 * and left the messages behind, pointing at an id that no longer existed. Seven such rows were in
 * the live database.
 */

function svc(over: any = {}) {
  const state: any = { deletedId: null, deletedMany: null };
  const prisma: any = {
    reminderMessage: {
      findUnique: async () => ('message' in over ? over.message : { id: 'm1', contactId: 'c1' }),
      delete: async ({ where }: any) => { state.deletedId = where.id; return {}; },
      deleteMany: async ({ where }: any) => { state.deletedMany = where; return { count: over.count ?? 12 }; },
      count: async () => over.count ?? 12,
    },
    contact: { findUnique: async () => ('contact' in over ? over.contact : { name: 'Deepthi' }) },
  };
  return { svc: new RemindersService(prisma, {} as any, {} as any, {} as any), state };
}

describe('deleting one message (BEA-1309)', () => {
  it('removes it, and says which conversation it was in', async () => {
    const { svc: s, state } = svc();
    const res: any = await (s as any).deleteMessage('m1');
    expect(state.deletedId).toBe('m1');
    expect(res.contactId).toBe('c1');
  });

  it('touches NOTHING else — not the task, not the chase, not the claim', async () => {
    // Deleting what somebody said must never quietly change what is owed. If it did, tidying a
    // conversation could silently close work or restart a chase.
    const state: any = { touched: [] as string[] };
    const prisma: any = {
      reminderMessage: { findUnique: async () => ({ id: 'm1', contactId: 'c1' }), delete: async () => ({}) },
      task: { update: async () => { state.touched.push('task'); } },
      reminder: { updateMany: async () => { state.touched.push('reminder'); } },
      taskClaim: { updateMany: async () => { state.touched.push('claim'); } },
    };
    await (new RemindersService(prisma, {} as any, {} as any, {} as any) as any).deleteMessage('m1');
    expect(state.touched).toEqual([]);
  });

  it('a message that is already gone is a clear error, not a silent success', async () => {
    const { svc: s } = svc({ message: null });
    await expect((s as any).deleteMessage('gone')).rejects.toThrow(/not there any more/i);
  });
});

describe('clearing a whole conversation (BEA-1309)', () => {
  it('removes every message with that ONE person', async () => {
    const { svc: s, state } = svc();
    const res: any = await (s as any).clearConversation('c1');
    expect(state.deletedMany).toEqual({ contactId: 'c1' });
    expect(res.deleted).toBe(12);
  });

  it('counts first, so the confirm can say what it is about to remove', async () => {
    const { svc: s } = svc({ count: 240 });
    expect(await (s as any).messageCount('c1')).toEqual({ count: 240 });
  });

  it('refuses for a contact that does not exist', async () => {
    const { svc: s, state } = svc({ contact: null });
    await expect((s as any).clearConversation('nobody')).rejects.toThrow(/not found/i);
    expect(state.deletedMany).toBeNull();
  });

  it('there is no way to delete EVERY conversation at once', () => {
    // The app holds his real history. A single mis-tap must never be able to take all of it, so the
    // only deletes that exist are one message and one conversation.
    const src = readFileSync(join(__dirname, 'reminders.controller.ts'), 'utf8');
    expect(src).not.toMatch(/@Delete\('messages'\)/);
    expect(src).not.toMatch(/clearAllConversations|deleteAllMessages/);
    const svcSrc = readFileSync(join(__dirname, 'reminders.service.ts'), 'utf8');
    // Every deleteMany on messages must be scoped to one contact.
    for (const call of svcSrc.match(/reminderMessage\s*\n?\s*\.deleteMany\([^)]*\)/g) || []) {
      expect(call).toMatch(/contactId/);
    }
  });
});

describe('a deleted message stays deleted (BEA-1309)', () => {
  /**
   * The de-duplication asks "have I stored this id before?", which was safe while messages were
   * immortal. Now that they can be deleted, a redelivered webhook — Postbox retries, and WhatsApp is
   * at-least-once — would find nothing, store it again, and set the two-way agent replying to
   * something the owner had just removed. (review finding)
   */
  it('remembers the id of a deleted inbound message', async () => {
    const kept: any[] = [];
    const prisma: any = {
      reminderMessage: { findUnique: async () => ({ id: 'm1', contactId: 'c1', wamid: 'wamid.IN1', direction: 'in' }), delete: async () => ({}) },
      deletedMessage: { createMany: async ({ data }: any) => { kept.push(...data); return { count: data.length }; } },
    };
    await (new RemindersService(prisma, {} as any, {} as any, {} as any) as any).deleteMessage('m1');
    expect(kept).toEqual([{ wamid: 'wamid.IN1' }]);
  });

  it('and every inbound id when a whole conversation is cleared', async () => {
    const kept: any[] = [];
    const prisma: any = {
      contact: { findUnique: async () => ({ name: 'Deepthi' }) },
      reminderMessage: {
        findMany: async () => [
          { wamid: 'in1', direction: 'in' },
          { wamid: 'out1', direction: 'out' }, // ours — nothing redelivers these
          { wamid: null, direction: 'in' }, // never had an id
          { wamid: 'in2', direction: 'in' },
        ],
        deleteMany: async () => ({ count: 4 }),
      },
      deletedMessage: { createMany: async ({ data }: any) => { kept.push(...data); return { count: data.length }; } },
    };
    await (new RemindersService(prisma, {} as any, {} as any, {} as any) as any).clearConversation('c1');
    expect(kept).toEqual([{ wamid: 'in1' }, { wamid: 'in2' }]);
  });

  it('keeps nothing but the id — no body, no sender, no conversation', () => {
    const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
    const block = schema.slice(schema.indexOf('model DeletedMessage'), schema.indexOf('model DeletedMessage') + 200);
    expect(block).toMatch(/wamid String\s+@id/);
    expect(block).not.toMatch(/body|contactId|direction/);
  });

  /**
   * Behavioural, not a grep. My first version searched the file for `deletedMessage?.findUnique`
   * and the words "ignored a redelivery" — and when I disabled the guard to check the test bit, it
   * did not: both strings were still sitting there. Fifth time this session. (self-caught)
   */
  function callback(over: { deleted?: boolean; existing?: any } = {}) {
    const state: any = { stored: [] as any[], agentFired: 0 };
    const prisma: any = {
      reminderMessage: {
        findFirst: async () => over.existing ?? null,
        create: async ({ data }: any) => { state.stored.push(data); return data; },
      },
      deletedMessage: { findUnique: async () => (over.deleted ? { wamid: 'wamid.IN9' } : null) },
      contact: { findFirst: async () => ({ id: 'c1', name: 'Deepthi' }) },
      reminderSend: { findFirst: async () => null },
    };
    const agent: any = { onContactReply: async () => { state.agentFired++; } };
    const { PostboxCallbackController } = require('./postbox-callback.controller');
    const c: any = new PostboxCallbackController(prisma, { callbackKey: 'k' } as any, agent);
    return { c, state };
  }

  const REDELIVERY = { kind: 'message', from: '919812345678', text: 'sir it is done', wamid: 'wamid.IN9' };

  it('a redelivery of a DELETED message is dropped — not stored, agent not fired', async () => {
    const { c, state } = callback({ deleted: true });
    await c.callback(REDELIVERY, 'k');
    expect(state.stored).toEqual([]);
    expect(state.agentFired).toBe(0);
  });

  it('but a genuinely new message is still stored and answered', async () => {
    // The pair that matters: without it, the first test passes just as happily when the whole
    // inbound path is broken.
    const { c, state } = callback({ deleted: false });
    await c.callback(REDELIVERY, 'k');
    expect(state.stored).toHaveLength(1);
    expect(state.agentFired).toBe(1);
  });
});

describe('messages can no longer outlive their person (BEA-1309)', () => {
  it('the schema makes it a real relation, not a convention', () => {
    const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
    const block = schema.slice(schema.indexOf('model ReminderMessage'), schema.indexOf('model ReminderMessage') + 1400);
    expect(block).toMatch(/contact\s+Contact\?\s+@relation\(fields: \[contactId\][^)]*onDelete: Cascade/);
  });

  it('the migration cleans the existing orphans BEFORE adding the constraint', () => {
    // Adding a constraint on top of rows that violate it is how a migration succeeds and leaves the
    // table quietly broken.
    const { readdirSync } = require('fs');
    const dir = join(__dirname, '../../prisma/migrations');
    const folder = readdirSync(dir).find((f: string) => f.endsWith('_chat_message_fk'));
    expect(folder).toBeTruthy();
    const sql = readFileSync(join(dir, folder, 'migration.sql'), 'utf8');
    expect(sql.indexOf('DELETE FROM "ReminderMessage"')).toBeGreaterThan(-1);
    expect(sql.indexOf('DELETE FROM "ReminderMessage"')).toBeLessThan(sql.indexOf('CREATE TABLE "new_ReminderMessage"'));
    // and the rebuild carries every column across
    for (const col of ['body', 'buttonId', 'contactId', 'createdAt', 'direction', 'error', 'id', 'reminderId', 'replyToWamid', 'status', 'wamid']) {
      expect(sql).toContain(`"${col}"`);
    }
  });

  it('the nightly check shouts if one ever appears again', async () => {
    const prisma: any = {
      reminderMessage: { findMany: async () => [{ contactId: 'ghost' }, { contactId: 'c1' }] },
      contact: { findMany: async () => [{ id: 'c1' }] },
      reminder: { findMany: async () => [], groupBy: async () => [] },
      reminderSend: { findMany: async () => [] },
      task: { findMany: async () => [] },
      taskClaim: { findMany: async () => [] },
    };
    const findings = await new TaskHealthService(prisma).check();
    const f = findings.find((x) => x.key === 'orphan-messages');
    expect(f?.count).toBe(1);
  });

  it('and stays quiet when every message has its person', async () => {
    const prisma: any = {
      reminderMessage: { findMany: async () => [{ contactId: 'c1' }] },
      contact: { findMany: async () => [{ id: 'c1' }] },
      reminder: { findMany: async () => [], groupBy: async () => [] },
      reminderSend: { findMany: async () => [] },
      task: { findMany: async () => [] },
      taskClaim: { findMany: async () => [] },
    };
    const findings = await new TaskHealthService(prisma).check();
    expect(findings.find((x) => x.key === 'orphan-messages')).toBeUndefined();
  });
});

describe('the chat screen offers it (BEA-1309)', () => {
  const page = readFileSync(join(__dirname, '../../../web/src/pages/Contacts.tsx'), 'utf8');

  it('every message can be deleted, and asks first', () => {
    expect(page).toContain('/api/reminders/messages/');
    expect(page).toMatch(/setDelMsg\(m\)/);
    expect(page).toMatch(/Delete this message\?/);
  });

  it('a conversation can be cleared, and the confirm says how many', () => {
    expect(page).toContain('/messages`, { method: \'DELETE\' }');
    expect(page).toMatch(/Clear this conversation\?/);
    expect(page).toMatch(/All \$\{clearAll\} message/);
  });

  it('and promises the work is untouched, because it is', () => {
    expect(page).toMatch(/tasks, chases and everything they have claimed stay/i);
  });
});
