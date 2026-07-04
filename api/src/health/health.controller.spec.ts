import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports ok when the database responds', async () => {
    const prisma: any = { $queryRaw: async () => [{ 1: 1 }] };
    const res = await new HealthController(prisma).health();
    expect(res.status).toBe('ok');
    expect(res.service).toBe('mybrain');
    expect(res.db).toBe('ok');
    expect(() => new Date(res.time).toISOString()).not.toThrow();
  });

  it('throws 503 when the database is unreachable (BEA-825)', async () => {
    const prisma: any = { $queryRaw: async () => { throw new Error('db down'); } };
    await expect(new HealthController(prisma).health()).rejects.toMatchObject({ status: 503 });
  });
});
