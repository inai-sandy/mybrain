import { AuthService } from './auth.service';
import * as bcrypt from 'bcryptjs';

function makeService(user: any) {
  const prisma: any = { user: { findUnique: async () => user } };
  return new AuthService(prisma);
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
