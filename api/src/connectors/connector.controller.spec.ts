import { ConnectorController } from './connector.controller';

describe('ConnectorController', () => {
  const svc: any = {
    set: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
    listStatus: jest.fn(async () => []),
    test: jest.fn(async () => ({ ok: true, message: 'works' })),
  };
  const c = new ConnectorController(svc);

  it('rejects an unknown connector', async () => {
    await expect(c.set('bogus', { apiKey: 'x' })).rejects.toThrow();
  });

  it('rejects empty values', async () => {
    await expect(c.set('notion', { token: '' })).rejects.toThrow();
  });

  it('stores a known connector with non-empty values', async () => {
    await c.set('notion', { token: 'secret-token' });
    expect(svc.set).toHaveBeenCalledWith('notion', { token: 'secret-token' });
  });

  it('disconnects a known connector', async () => {
    await c.remove('notion');
    expect(svc.remove).toHaveBeenCalledWith('notion');
  });

  it('rejects testing an unknown connector', async () => {
    await expect(c.test('bogus')).rejects.toThrow();
  });

  it('delegates a known connector test to the service', async () => {
    const res = await c.test('tavily');
    expect(svc.test).toHaveBeenCalledWith('tavily');
    expect(res).toEqual({ ok: true, message: 'works' });
  });
});
