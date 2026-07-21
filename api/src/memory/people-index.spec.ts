import { MemoryService } from './memory.service';

/**
 * What the brain stores about people. The owner's decision: tasks tagged with their person,
 * briefings, and ONE rolling doc per contact — never the raw WhatsApp chatter. (BEA-1031)
 */
const svc = () => new MemoryService({} as any, {} as any, {} as any) as any;

const day = (n: number) => new Date(Date.now() - n * 86400000);

describe('a task carries who it belongs to (BEA-1031)', () => {
  it('says who is being waited on, and tags their first name', () => {
    const b = svc().buildContent('task', { title: 'Send the vendor list', party: 'Vijaya Durga', status: 'open', createdAt: day(3), sphere: 'work' });
    expect(b.content).toContain('Waiting on: Vijaya Durga');
    expect(b.tags).toContain('vijaya');
  });

  it('uses past tense once it is finished', () => {
    const b = svc().buildContent('task', { title: 'x', party: 'Ramesh', status: 'done', completedAt: day(1), createdAt: day(5) });
    expect(b.content).toContain('Was with: Ramesh');
  });

  it('includes a promised date while it is open', () => {
    const b = svc().buildContent('task', { title: 'x', party: 'Ramesh', status: 'open', createdAt: day(1), promisedFor: '2026-08-01' });
    expect(b.content).toContain('They promised: 2026-08-01');
  });

  it('a task of the owner’s own says nothing about a person', () => {
    const b = svc().buildContent('task', { title: 'My own job', party: null, status: 'open', createdAt: day(1) });
    expect(b.content).not.toContain('Waiting on');
  });
});

describe('a briefing is stored in his own words (BEA-1031)', () => {
  it('keeps the raw text and names the person', () => {
    const b = svc().buildContent('briefing', { rawText: 'He owes the GST filing by Friday', summary: 'GST', createdAt: day(1), contact: { name: 'Ramesh' } });
    expect(b.content).toContain('He owes the GST filing by Friday');
    expect(b.title).toContain('Ramesh');
    expect(b.tags).toContain('ramesh');
  });
});

describe('one rolling doc per person (BEA-1031)', () => {
  const contact = {
    name: 'Ramesh',
    ownedTasks: [
      { title: 'Send the vendor list', status: 'open', createdAt: day(9), promisedFor: '2026-08-01' },
      { title: 'GST filing', status: 'done', createdAt: day(30) },
    ],
  };

  it('says what is outstanding, for how long, and what they promised', () => {
    const b = svc().buildContent('contact', contact);
    expect(b.content).toContain('Waiting on Ramesh (1)');
    expect(b.content).toContain('open 9 days');
    expect(b.content).toContain('they promised 2026-08-01');
  });

  it('lists what is already finished separately', () => {
    const b = svc().buildContent('contact', contact);
    expect(b.content).toContain('Already finished with Ramesh (1)');
    expect(b.content).toContain('GST filing');
  });

  it('says so plainly when nothing is outstanding', () => {
    const b = svc().buildContent('contact', { name: 'Preeti', ownedTasks: [] });
    expect(b.content).toContain('Nothing is outstanding with Preeti');
  });

  it('is findable by their first name', () => {
    expect(svc().buildContent('contact', { name: 'Vijaya Durga', ownedTasks: [] }).tags).toContain('vijaya');
  });
});

describe('raw WhatsApp chatter is NOT a brain source (BEA-1031)', () => {
  it('has no builder for messages', () => {
    expect(svc().buildContent('remindermessage', { body: 'ok' })).toBeNull();
    expect(svc().buildContent('reminder', { message: 'chase' })).toBeNull();
  });
});
