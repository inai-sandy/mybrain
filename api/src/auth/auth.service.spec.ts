import { Logger } from '@nestjs/common';
import {
  AuthService,
  DEVICE_TOKEN_GRACE_DAYS,
  DEVICE_TOKEN_KEY,
  DEVICE_TOKEN_PREV_COUNT_KEY,
  DEVICE_TOKEN_PREV_KEY,
  DEVICE_TOKEN_PREV_LASTSEEN_KEY,
  DEVICE_TOKEN_PREV_UNTIL_KEY,
} from './auth.service';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';

const SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';

function makeService(user: any) {
  const prisma: any = { user: { findUnique: async () => user } };
  return new AuthService(prisma);
}

/** An in-memory Setting table + one owner, enough for the device-token rotation path. */
function makeDeviceService(seed: Record<string, string> = {}) {
  const settings = new Map<string, string>(Object.entries(seed));
  const prisma: any = {
    setting: {
      findUnique: async ({ where }: any) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null),
      upsert: async ({ where, create, update }: any) => {
        const value = settings.has(where.key) ? (update?.value ?? settings.get(where.key)) : create.value;
        settings.set(where.key, value as string);
        return { key: where.key, value };
      },
    },
    user: {
      findUnique: async () => ({ id: 'u1', email: 'owner@example.com', passwordHash: 'x' }),
      create: async () => ({ id: 'u1', email: 'owner@example.com' }),
      findFirst: async () => ({ id: 'u1', email: 'owner@example.com' }),
    },
  };
  const svc = new AuthService(prisma);
  return { svc, settings };
}

describe('AuthService', () => {
  it('accepts correct credentials and round-trips a session token', async () => {
    const passwordHash = await bcrypt.hash('s3cret', 4);
    const svc = makeService({ id: 'u1', email: 'a@b.com', passwordHash });
    const u = await svc.validate('a@b.com', 's3cret');
    expect(u.email).toBe('a@b.com');
    const token = svc.issueToken(u);
    expect(svc.verifyToken(token)?.id).toBe('u1');
  });

  it('rejects a wrong password', async () => {
    const passwordHash = await bcrypt.hash('s3cret', 4);
    const svc = makeService({ id: 'u1', email: 'a@b.com', passwordHash });
    await expect(svc.validate('a@b.com', 'WRONG')).rejects.toThrow();
  });

  it('treats a missing/invalid session as logged out', () => {
    const svc = makeService(null);
    expect(svc.verifyToken('garbage')).toBeNull();
  });

  it('rejects an OAuth access/refresh token replayed as a session cookie (BEA-777)', () => {
    const svc = makeService(null);
    // same secret as the session tokens, but these are OAuth MCP tokens — must NOT authenticate a login
    const access = jwt.sign({ sub: 'u1', scope: 'read', typ: 'access' }, SECRET, { audience: 'mcp', expiresIn: 3600 });
    const refresh = jwt.sign({ sub: 'u1', scope: 'read', typ: 'refresh' }, SECRET, { audience: 'mcp', expiresIn: 3600 });
    expect(svc.verifyToken(access)).toBeNull();
    expect(svc.verifyToken(refresh)).toBeNull();
  });

  it('rejects a same-secret token that lacks session claims (id/email) (BEA-777)', () => {
    const svc = makeService(null);
    expect(svc.verifyToken(jwt.sign({ sub: 'u1', scope: 'read' }, SECRET, { audience: 'mcp' }))).toBeNull();
    expect(svc.verifyToken(jwt.sign({ foo: 'bar' }, SECRET))).toBeNull();
  });

  it('still accepts a legacy session token minted without typ (no forced logout) (BEA-777)', () => {
    const svc = makeService(null);
    const legacy = jwt.sign({ id: 'u1', email: 'a@b.com' }, SECRET, { expiresIn: 3600 }); // pre-fix cookie
    expect(svc.verifyToken(legacy)?.id).toBe('u1');
  });

  it('rejects a wrong current password on change', async () => {
    const passwordHash = await bcrypt.hash('right', 4);
    const svc = makeService({ id: 'u1', email: 'a@b.com', passwordHash });
    await expect(svc.changePassword('a@b.com', 'wrong', 'newpass12')).rejects.toThrow();
  });

  it('rejects a too-short new password', async () => {
    const passwordHash = await bcrypt.hash('right', 4);
    const svc = makeService({ id: 'u1', email: 'a@b.com', passwordHash });
    await expect(svc.changePassword('a@b.com', 'right', 'short')).rejects.toThrow();
  });

  // --- EMO device token rotation (DEVICE-TOKEN-ROTATION) --------------------------------------
  // The token was exposed in a public firmware repo. Rotating it must never lock out the prototypes
  // that are still on the old firmware, so two keys are live at once for a grace period.
  describe('device token rotation', () => {
    const DAY = 24 * 60 * 60 * 1000;

    it('accepts the current token and refuses an unknown one', async () => {
      const { svc } = makeDeviceService({ [DEVICE_TOKEN_KEY]: 'emod_current' });
      await svc.onModuleInit();
      expect(svc.verifyDeviceToken('emod_current')).toBe(true);
      expect(svc.verifyDeviceToken('emod_nonsense')).toBe(false);
      expect(svc.verifyDeviceToken('')).toBe(false);
      expect(svc.verifyDeviceToken(undefined)).toBe(false);
    });

    it('accepts the PREVIOUS token before its deadline', async () => {
      const { svc } = makeDeviceService({
        [DEVICE_TOKEN_KEY]: 'emod_new',
        [DEVICE_TOKEN_PREV_KEY]: 'emod_old',
        [DEVICE_TOKEN_PREV_UNTIL_KEY]: new Date(Date.now() + 5 * DAY).toISOString(),
      });
      await svc.onModuleInit();
      expect(svc.verifyDeviceToken('emod_old')).toBe(true);
      expect(svc.verifyDeviceToken('emod_new')).toBe(true);
    });

    it('refuses the PREVIOUS token once the deadline has passed', async () => {
      const { svc } = makeDeviceService({
        [DEVICE_TOKEN_KEY]: 'emod_new',
        [DEVICE_TOKEN_PREV_KEY]: 'emod_old',
        [DEVICE_TOKEN_PREV_UNTIL_KEY]: new Date(Date.now() - 1 * DAY).toISOString(),
      });
      await svc.onModuleInit();
      expect(svc.verifyDeviceToken('emod_old')).toBe(false);
      expect(svc.verifyDeviceToken('emod_new')).toBe(true);
    });

    it('rotation keeps the old key working and sets a 30-day deadline', async () => {
      const { svc, settings } = makeDeviceService({ [DEVICE_TOKEN_KEY]: 'emod_old' });
      await svc.onModuleInit();
      const minted = await svc.regenerateDeviceToken();
      expect(minted).not.toBe('emod_old');
      expect(settings.get(DEVICE_TOKEN_KEY)).toBe(minted);
      expect(settings.get(DEVICE_TOKEN_PREV_KEY)).toBe('emod_old');
      const until = Date.parse(settings.get(DEVICE_TOKEN_PREV_UNTIL_KEY) || '');
      const days = (until - Date.now()) / DAY;
      expect(days).toBeGreaterThan(DEVICE_TOKEN_GRACE_DAYS - 0.1);
      expect(days).toBeLessThan(DEVICE_TOKEN_GRACE_DAYS + 0.1);
      // nothing has used the old key yet, and the owner is never handed its value back
      const view = await svc.deviceTokenView();
      expect(view.token).toBe(minted);
      expect(view.previous).toMatchObject({ active: true, count: 0, lastSeenAt: null });
      expect(JSON.stringify(view)).not.toContain('emod_old');
      // both keys are live
      expect(svc.verifyDeviceToken(minted)).toBe(true);
      expect(svc.verifyDeviceToken('emod_old')).toBe(true);
    });

    it('revoke stops the old key at once', async () => {
      const { svc, settings } = makeDeviceService({ [DEVICE_TOKEN_KEY]: 'emod_old' });
      await svc.onModuleInit();
      const minted = await svc.regenerateDeviceToken();
      expect(svc.verifyDeviceToken('emod_old')).toBe(true);
      await svc.revokePreviousDeviceToken();
      expect(svc.verifyDeviceToken('emod_old')).toBe(false);
      expect(svc.verifyDeviceToken(minted)).toBe(true);
      expect(settings.get(DEVICE_TOKEN_PREV_KEY)).toBe('');
      expect((await svc.deviceTokenView()).previous).toBeNull();
    });

    it('records lastseen + a count ONLY for the previous token', async () => {
      const { svc, settings } = makeDeviceService({ [DEVICE_TOKEN_KEY]: 'emod_old' });
      await svc.onModuleInit();
      const minted = await svc.regenerateDeviceToken();

      svc.verifyDeviceToken(minted, 'POST /api/emo/capture');
      await svc.prevUseWrite;
      expect(settings.get(DEVICE_TOKEN_PREV_LASTSEEN_KEY)).toBe(''); // the current key leaves no trace
      expect((await svc.deviceTokenView()).previous?.count).toBe(0);

      svc.verifyDeviceToken('emod_old', 'POST /api/emo/capture');
      await svc.prevUseWrite;
      svc.verifyDeviceToken('emod_old', 'GET /api/emo/cards');
      await svc.prevUseWrite;
      expect(settings.get(DEVICE_TOKEN_PREV_COUNT_KEY)).toBe('2');
      expect(settings.get(DEVICE_TOKEN_PREV_LASTSEEN_KEY)).toBeTruthy();
      const prev = (await svc.deviceTokenView()).previous;
      expect(prev?.count).toBe(2);
      expect(prev?.lastSeenAt).toBeTruthy();
    });

    it('refuses a SECOND rotation while the old key is still live, unless forced', async () => {
      const { svc } = makeDeviceService({ [DEVICE_TOKEN_KEY]: 'emod_leaked' });
      await svc.onModuleInit();
      const second = await svc.regenerateDeviceToken();
      // rotating again would kill emod_leaked on the spot — that is the lockout we are avoiding
      await expect(svc.regenerateDeviceToken()).rejects.toThrow(/still works until/i);
      expect(svc.verifyDeviceToken('emod_leaked')).toBe(true);
      expect(svc.verifyDeviceToken(second)).toBe(true);
      // the owner can insist (a fresh leak) — and then the first old key really does stop
      const third = await svc.regenerateDeviceToken({ force: true });
      expect(svc.verifyDeviceToken('emod_leaked')).toBe(false);
      expect(svc.verifyDeviceToken(second)).toBe(true);
      expect(svc.verifyDeviceToken(third)).toBe(true);
    });

    it('two sightings in the same tick do not race the stored lastseen backwards', async () => {
      const { svc, settings } = makeDeviceService({ [DEVICE_TOKEN_KEY]: 'emod_old' });
      await svc.onModuleInit();
      await svc.regenerateDeviceToken();
      svc.verifyDeviceToken('emod_old', 'POST /api/emo/capture');
      svc.verifyDeviceToken('emod_old', 'POST /api/emo/capture');
      svc.verifyDeviceToken('emod_old', 'GET /api/emo/cards');
      await svc.prevUseWrite;
      expect(settings.get(DEVICE_TOKEN_PREV_COUNT_KEY)).toBe('3');
      const stored = settings.get(DEVICE_TOKEN_PREV_LASTSEEN_KEY) || '';
      expect(stored).toBe((await svc.deviceTokenView()).previous?.lastSeenAt);
    });

    it('never writes any token value into a log line', async () => {
      const lines: string[] = [];
      const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation((m: any) => { lines.push(String(m)); });
      try {
        const { svc } = makeDeviceService({ [DEVICE_TOKEN_KEY]: 'emod_old_secret_value' });
        await svc.onModuleInit();
        const minted = await svc.regenerateDeviceToken();
        svc.verifyDeviceToken('emod_old_secret_value', 'POST /api/emo/capture');
        await svc.prevUseWrite;
        svc.verifyDeviceToken(minted, 'POST /api/emo/capture');
        svc.verifyDeviceToken('emod_bogus', 'POST /api/emo/capture');
        await svc.revokePreviousDeviceToken();
        expect(lines.length).toBeGreaterThan(0);
        const all = lines.join('\n');
        for (const secret of ['emod_old_secret_value', minted, 'emod_bogus']) {
          expect(all).not.toContain(secret);
          // not even a fragment of one
          expect(all).not.toContain(secret.slice(5, 15));
        }
        // it still says WHICH route the stale device hit, so the owner can find it
        expect(all).toContain('POST /api/emo/capture');
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('updates the hash on a valid change', async () => {
    const passwordHash = await bcrypt.hash('right', 4);
    let updated: any = null;
    const prisma: any = {
      user: { findUnique: async () => ({ id: 'u1', email: 'a@b.com', passwordHash }), update: async ({ data }: any) => { updated = data; } },
    };
    const svc = new AuthService(prisma);
    await svc.changePassword('a@b.com', 'right', 'newpass12');
    expect(updated.passwordHash).toBeTruthy();
  });
});
