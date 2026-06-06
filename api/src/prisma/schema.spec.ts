import { execSync } from 'child_process';
import { join } from 'path';
import { existsSync, rmSync } from 'fs';

const API_DIR = join(__dirname, '..', '..');
const TEST_DB = join(API_DIR, 'prisma', 'test.db');

describe('Prisma schema', () => {
  let prisma: any;

  beforeAll(() => {
    process.env.DATABASE_URL = `file:${TEST_DB}`;
    if (existsSync(TEST_DB)) rmSync(TEST_DB);
    // Create the schema in a throwaway sqlite db.
    execSync('npx prisma db push --skip-generate --accept-data-loss', {
      cwd: API_DIR,
      env: { ...process.env, DATABASE_URL: `file:${TEST_DB}` },
      stdio: 'ignore',
    });
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (existsSync(TEST_DB)) rmSync(TEST_DB);
  });

  it('creates and reads one row in every table', async () => {
    const item = await prisma.item.create({ data: { contentHash: 'h1', source: 'upload', title: 'T' } });
    const task = await prisma.task.create({ data: { title: 'do x' } });
    const outbox = await prisma.memoryOutbox.create({ data: { target: 'rag', payload: '{}' } });
    const sync = await prisma.syncState.create({ data: { id: 'raindrop', cursor: '0' } });
    const chat = await prisma.chatSession.create({ data: { title: 'c' } });
    const log = await prisma.agentActionLog.create({ data: { tool: 'search' } });

    expect(await prisma.item.findUnique({ where: { id: item.id } })).toBeTruthy();
    expect(await prisma.task.findUnique({ where: { id: task.id } })).toBeTruthy();
    expect(await prisma.memoryOutbox.findUnique({ where: { id: outbox.id } })).toBeTruthy();
    expect(await prisma.syncState.findUnique({ where: { id: sync.id } })).toBeTruthy();
    expect(await prisma.chatSession.findUnique({ where: { id: chat.id } })).toBeTruthy();
    expect(await prisma.agentActionLog.findUnique({ where: { id: log.id } })).toBeTruthy();
  });
});
