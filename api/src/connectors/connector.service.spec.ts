import { ConnectorService } from './connector.service';

describe('ConnectorService', () => {
  it('stores secrets encrypted at rest and reads them back decrypted', async () => {
    let stored: { name: string; secrets: string } | null = null;
    const prisma: any = {
      connector: {
        upsert: async ({ create }: any) => {
          stored = { name: create.name, secrets: create.secrets };
          return stored;
        },
        findUnique: async () => stored,
      },
    };
    const svc = new ConnectorService(prisma);

    await svc.set('supermemory', { apiKey: 'sm_secret_abc' });
    // What lands in the DB must NOT contain the plaintext.
    expect(stored!.secrets).not.toContain('sm_secret_abc');
    // But reading it back returns the original object.
    expect(await svc.get('supermemory')).toEqual({ apiKey: 'sm_secret_abc' });
  });
});
