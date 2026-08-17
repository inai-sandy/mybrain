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
