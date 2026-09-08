import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { EmoSettingsSection } from './Settings';

/**
 * DEVICE-TOKEN-ROTATION — Settings → EMO → Device token.
 * The shared EMO key leaked through a public firmware repo, so rotating it hands out a NEW key while
 * the old one keeps working for 30 days. This locks down what the owner actually sees and taps:
 *  - the current key masked, with Show and Copy (unchanged);
 *  - a Rotate button whose warning says the old key keeps working;
 *  - while a previous key is live: when it was last used, how many requests, and Revoke now;
 *  - the old key's VALUE is never in the payload the page reads, so it can never be drawn.
 */
vi.mock('../ui/Toast', () => ({ useToast: () => vi.fn() }));

const NOW = Date.now();
const PREVIOUS = { active: true, until: new Date(NOW + 30 * 864e5).toISOString(), lastSeenAt: new Date(NOW - 2 * 36e5).toISOString(), count: 7 };

function stubFetch(deviceToken: any) {
  return vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    if (u === '/api/auth/device-token') return { json: async () => deviceToken } as any;
    if (u === '/api/auth/device-token/regenerate') return { json: async () => ({ token: 'emod_brandnew0000', previous: { ...PREVIOUS, lastSeenAt: null, count: 0 } }) } as any;
    if (u === '/api/auth/device-token/revoke-previous') return { json: async () => ({ ok: true, previous: null }) } as any;
    if (u.startsWith('/api/voice/tts-voice')) return { json: async () => ({ voice: 'nova', voices: ['nova'] }) } as any;
    if (u.startsWith('/api/voice/config')) return { json: async () => ({ engine: 'deepgram', engines: [] }) } as any;
    if (u.startsWith('/api/explore/model')) return { json: async () => ({ model: 'anthropic/claude-sonnet-5' }) } as any;
    if (u.startsWith('/api/emo/settings')) return { json: async () => ({ talkModel: '', routerModel: '', models: [], searchDefault: 'auto', deviceVolume: 60 }) } as any;
    void init;
    return { json: async () => ({}) } as any;
  });
}

async function openDeviceTokenCard() {
  render(<MemoryRouter><EmoSettingsSection /></MemoryRouter>);
  const header = await screen.findByText('Device token');
  fireEvent.click(header);
}

describe('Settings → EMO → Device token (DEVICE-TOKEN-ROTATION)', () => {
  beforeEach(() => { vi.stubGlobal('fetch', stubFetch({ token: 'emod_currentkey1234567890', previous: PREVIOUS })); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('masks the current key and reveals it on Show', async () => {
    await openDeviceTokenCard();
    const box = await screen.findByDisplayValue('emod_cu••••••••••••••7890');
    fireEvent.click(screen.getByText('Show'));
    await waitFor(() => expect((box as HTMLInputElement).value).toBe('emod_currentkey1234567890'));
  });

  it('says the old key was last used, how many requests, and offers Revoke now', async () => {
    await openDeviceTokenCard();
    const box = await screen.findByTestId('device-token-previous');
    expect(box.textContent).toContain('The old key was last used');
    expect(box.textContent).toContain('2 hours ago');
    expect(box.textContent).toContain('(7 requests)');
    expect(box.textContent).toContain('Revoke it once every device is updated.');
    expect(screen.getByTestId('device-token-revoke')).toBeTruthy();
  });

  it('rotating warns that the old key keeps working, and shows the new key', async () => {
    const confirm = vi.fn((_msg?: string) => true);
    vi.stubGlobal('confirm', confirm);
    vi.stubGlobal('fetch', stubFetch({ token: 'emod_currentkey1234567890', previous: null }));
    await openDeviceTokenCard();
    await screen.findByTestId('device-token-rotate');
    fireEvent.click(screen.getByTestId('device-token-rotate'));
    expect(String(confirm.mock.calls[0][0])).toContain('keep working on the OLD key for 30 more days');
    await waitFor(() => expect(screen.getByDisplayValue('emod_brandnew0000')).toBeTruthy());
    // straight after a rotation nothing has used the old key yet — but it is still live
    await waitFor(() => expect(screen.getByTestId('device-token-previous').textContent).toContain('has not been used yet'));
  });

  it('rotating a SECOND time says the still-live old key stops immediately, and forces it', async () => {
    const confirm = vi.fn((_msg?: string) => true);
    vi.stubGlobal('confirm', confirm);
    const fetchMock = stubFetch({ token: 'emod_currentkey1234567890', previous: PREVIOUS });
    vi.stubGlobal('fetch', fetchMock);
    await openDeviceTokenCard();
    fireEvent.click(await screen.findByTestId('device-token-rotate'));
    expect(String(confirm.mock.calls[0][0])).toContain('will stop working right away');
    const call = fetchMock.mock.calls.find((c: any) => String(c[0]).endsWith('/regenerate'));
    expect(JSON.parse(String((call?.[1] as any)?.body))).toEqual({ force: true });
  });

  it('an expired old key is CLEARED away, not "revoked", and the warning does not lie', async () => {
    const confirm = vi.fn((_msg?: string) => true);
    vi.stubGlobal('confirm', confirm);
    vi.stubGlobal('fetch', stubFetch({ token: 'emod_currentkey1234567890', previous: { ...PREVIOUS, active: false } }));
    await openDeviceTokenCard();
    const btn = await screen.findByTestId('device-token-revoke');
    expect(btn.textContent).toBe('Clear it away');
    expect((await screen.findByTestId('device-token-previous')).textContent).toContain('has expired and no longer works');
    fireEvent.click(btn);
    expect(String(confirm.mock.calls[0][0])).toContain('nothing will change for your devices');
  });

  it('Revoke now confirms first, then the old-key line is gone', async () => {
    const confirm = vi.fn((_msg?: string) => true);
    vi.stubGlobal('confirm', confirm);
    await openDeviceTokenCard();
    fireEvent.click(await screen.findByTestId('device-token-revoke'));
    expect(String(confirm.mock.calls[0][0])).toContain('will stop working immediately');
    await waitFor(() => expect(screen.queryByTestId('device-token-previous')).toBeNull());
  });

  it('draws nothing when there is no previous key', async () => {
    vi.stubGlobal('fetch', stubFetch({ token: 'emod_currentkey1234567890', previous: null }));
    await openDeviceTokenCard();
    await screen.findByTestId('device-token-rotate');
    expect(screen.queryByTestId('device-token-previous')).toBeNull();
  });
});
