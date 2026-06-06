import { HealthController } from './health.controller';

describe('HealthController', () => {
  const controller = new HealthController();

  it('reports ok status', () => {
    const res = controller.health();
    expect(res.status).toBe('ok');
    expect(res.service).toBe('mybrain');
  });

  it('includes an ISO timestamp', () => {
    const res = controller.health();
    expect(() => new Date(res.time).toISOString()).not.toThrow();
  });
});
