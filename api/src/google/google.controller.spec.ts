import { BadRequestException } from '@nestjs/common';
import { GoogleController } from './google.controller';

/**
 * The /google endpoints answer a missing login with the NAME of the service to connect (BEA-1351) —
 * "Google Tasks isn't connected yet", not a generic sentence about Gmail when it was Tasks that was
 * asked for. Everything else comes through as the service's own reason.
 */
function controller(google: any) {
  return new GoogleController(google, {} as any, {} as any, {} as any);
}

describe('GoogleController — friendly errors', () => {
  it('names the service that needs connecting', async () => {
    const c = controller({ tasks: async () => { throw new Error('not-connected:googletasks'); } });
    await expect(c.tasks()).rejects.toThrow(BadRequestException);
    await expect(c.tasks()).rejects.toThrow(/Google Tasks isn’t connected yet.*Tools/);
  });

  it('falls back to a plain sentence when the service is not one it knows', async () => {
    const c = controller({ calendar: async () => { throw new Error('not-connected:something_new'); } });
    await expect(c.calendar()).rejects.toThrow(/that Google service isn’t connected yet/);
  });

  it('passes the service\'s own reason through unchanged', async () => {
    const c = controller({ driveList: async () => { throw new Error('Requested entity was not found.'); } });
    await expect(c.drive('x')).rejects.toThrow('Requested entity was not found.');
  });
});

describe('GoogleController — the Gmail cap and counter (BEA-1399)', () => {
  it('a refused call past the cap becomes one plain sentence with the numbers', async () => {
    const c = controller({ gmailList: async () => { throw new Error('gmail-cap:60:60'); } });
    await expect(c.gmail()).rejects.toThrow(BadRequestException);
    await expect(c.gmail()).rejects.toThrow(/Gmail’s daily call cap \(60\) is used up for today.*midnight.*Settings/);
  });

  it('serves the usage and takes a new cap, refusing nonsense', async () => {
    const usage = { day: '2026-08-22', calls: 3, cap: 60 };
    const setGmailCap = jest.fn(async (n: number) => { if (!(n >= 0)) throw new Error('bad'); return n; });
    const c = controller({ gmailUsage: async () => usage, setGmailCap });
    expect(await c.gmailUsage()).toEqual(usage);
    expect(await c.setGmailCap({ cap: 100 })).toEqual({ cap: 100 });
    await expect(c.setGmailCap({ cap: -5 })).rejects.toThrow(BadRequestException);
    await expect(c.setGmailCap({} as any)).rejects.toThrow(BadRequestException);
  });
});
