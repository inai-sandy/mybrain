import { describeTransportError, fetchWithRetry, isTransportError, transportCause } from './transport';

/** BEA-1364 — the transport helper both providers share. */
describe('transport (BEA-1364)', () => {
  const origFetch = global.fetch;
  afterEach(() => { global.fetch = origFetch; });

  const undiciError = (code: string, message: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) });

  it('names the cause: code + message, no stack, and copes with a cause that has no code', () => {
    expect(describeTransportError(undiciError('ECONNRESET', 'socket hang up'))).toBe('fetch failed (ECONNRESET: socket hang up)');
    expect(describeTransportError(Object.assign(new TypeError('fetch failed'), { cause: new Error('certificate has expired') }))).toBe('fetch failed (certificate has expired)');
    expect(describeTransportError(new TypeError('fetch failed'))).toBe('fetch failed');
    expect(transportCause({})).toBe('');
    expect(describeTransportError(undiciError('ECONNRESET', 'socket hang up'))).not.toContain('\n');
  });

  it('a timeout, an abort or an HTTP-status error is NOT a transport error', () => {
    expect(isTransportError(undiciError('ECONNRESET', 'socket hang up'))).toBe(true);
    expect(isTransportError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isTransportError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(false);
    expect(isTransportError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(false);
    expect(isTransportError(Object.assign(new Error('HTTP 429'), { status: 429 }))).toBe(false);
    expect(isTransportError(null)).toBe(false);
  });

  it('retries once on a rejected fetch, waits between, and gives up after the second failure', async () => {
    let n = 0;
    global.fetch = (async () => { n += 1; if (n === 1) throw undiciError('ECONNRESET', 'socket hang up'); return { ok: true, status: 200 } as any; }) as any;
    const waited: number[] = [];
    const r = await fetchWithRetry('https://api.example.com/x', {}, { sleep: async (ms) => { waited.push(ms); } });
    expect(r.status).toBe(200);
    expect(n).toBe(2);
    expect(waited).toEqual([400]);

    n = 0;
    global.fetch = (async () => { n += 1; throw undiciError('EAI_AGAIN', 'getaddrinfo EAI_AGAIN api.example.com'); }) as any;
    await expect(fetchWithRetry('https://api.example.com/x', {}, { sleep: async () => undefined })).rejects.toMatchObject({ message: 'fetch failed' });
    expect(n).toBe(2);
  });

  it('each attempt gets its OWN timeout signal — the retry is not born half-spent', async () => {
    const signals: any[] = [];
    let n = 0;
    global.fetch = (async (_u: string, init: any) => { signals.push(init.signal); n += 1; if (n === 1) throw undiciError('ECONNRESET', 'socket hang up'); return { ok: true, status: 200 } as any; }) as any;
    await fetchWithRetry('https://api.example.com/x', { method: 'GET' }, { timeoutMs: 5000, sleep: async () => undefined });
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBeInstanceOf(AbortSignal);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it('a timeout is rethrown untouched with no second attempt', async () => {
    let n = 0;
    global.fetch = (async () => { n += 1; throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }) as any;
    await expect(fetchWithRetry('https://api.example.com/x', {}, { sleep: async () => undefined })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(n).toBe(1);
  });
});
