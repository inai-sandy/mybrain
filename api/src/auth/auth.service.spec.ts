import { AuthService } from './auth.service';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';

const SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';

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
