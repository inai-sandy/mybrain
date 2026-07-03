import { createHash, randomBytes } from 'crypto';
import { OAuthService, OAUTH_SCOPE } from './oauth.service';

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function makePrisma() {
  const clients: any[] = [];
  const codes: any[] = [];
  const prisma: any = {
    oAuthClient: {
      create: async ({ data }: any) => { clients.push({ ...data }); return data; },
      findUnique: async ({ where }: any) => clients.find((c) => c.id === where.id) || null,
    },
    oAuthCode: {
      create: async ({ data }: any) => { codes.push({ ...data }); return data; },
      findUnique: async ({ where }: any) => codes.find((c) => c.code === where.code) || null,
      update: async ({ where, data }: any) => { const c = codes.find((x) => x.code === where.code); Object.assign(c, data); return c; },
    },
  };
  return { prisma, clients, codes };
}

describe('OAuthService — DCR (BEA-758)', () => {
  it('registers an https client and rejects bad redirect_uris', async () => {
    const { prisma } = makePrisma();
    const svc = new OAuthService(prisma);
    const reg = await svc.register({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' });
    expect(reg.client_id).toMatch(/^mbc_/);
    expect(reg.token_endpoint_auth_method).toBe('none');
    await expect(svc.register({ redirect_uris: [] })).rejects.toBeTruthy();
    await expect(svc.register({ redirect_uris: ['http://evil.com/cb'] })).rejects.toBeTruthy(); // non-https, non-localhost
  });
});

describe('OAuthService — authorize validation (BEA-758)', () => {
  it('enforces response_type, PKCE, known client, exact redirect_uri', async () => {
    const { prisma } = makePrisma();
    const svc = new OAuthService(prisma);
    const { client_id } = await svc.register({ redirect_uris: ['https://claude.ai/cb'] });
    const good = { response_type: 'code', client_id, redirect_uri: 'https://claude.ai/cb', code_challenge: 'abc', code_challenge_method: 'S256' };
    await expect(svc.validateAuthorize(good)).resolves.toMatchObject({ clientId: client_id, redirectUri: 'https://claude.ai/cb' });
    await expect(svc.validateAuthorize({ ...good, response_type: 'token' })).rejects.toBeTruthy();
    await expect(svc.validateAuthorize({ ...good, code_challenge_method: 'plain' })).rejects.toBeTruthy();
    await expect(svc.validateAuthorize({ ...good, redirect_uri: 'https://claude.ai/other' })).rejects.toBeTruthy();
    await expect(svc.validateAuthorize({ ...good, client_id: 'nope' })).rejects.toBeTruthy();
  });
});

describe('OAuthService — PKCE code→token round-trip (BEA-758)', () => {
  it('issues tokens for the right verifier, rejects wrong/expired/reused codes', async () => {
    const { prisma, codes } = makePrisma();
    const svc = new OAuthService(prisma);
    const { client_id } = await svc.register({ redirect_uris: ['https://claude.ai/cb'] });
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const url = await svc.issueCode({ clientId: client_id, redirectUri: 'https://claude.ai/cb', challenge, state: 'xyz', userId: 'u1' });
    const code = new URL(url).searchParams.get('code')!;
    expect(new URL(url).searchParams.get('state')).toBe('xyz');

    // wrong verifier → rejected
    await expect(svc.exchangeCode({ code, client_id, redirect_uri: 'https://claude.ai/cb', code_verifier: 'wrong' })).rejects.toBeTruthy();
    // right verifier → tokens
    const tok = await svc.exchangeCode({ code, client_id, redirect_uri: 'https://claude.ai/cb', code_verifier: verifier });
    expect(tok.token_type).toBe('Bearer');
    expect(OAuthService.verifyAccess(tok.access_token)?.sub).toBe('u1');
    // reuse → rejected (single-use)
    await expect(svc.exchangeCode({ code, client_id, redirect_uri: 'https://claude.ai/cb', code_verifier: verifier })).rejects.toBeTruthy();

    // expired code → rejected
    const url2 = await svc.issueCode({ clientId: client_id, redirectUri: 'https://claude.ai/cb', challenge, userId: 'u1' });
    const code2 = new URL(url2).searchParams.get('code')!;
    codes.find((c) => c.code === code2).expiresAt = new Date(Date.now() - 1000);
    await expect(svc.exchangeCode({ code: code2, client_id, redirect_uri: 'https://claude.ai/cb', code_verifier: verifier })).rejects.toBeTruthy();
  });

  it('refresh_token grant mints a fresh access token; garbage tokens fail verifyAccess', async () => {
    const { prisma } = makePrisma();
    const svc = new OAuthService(prisma);
    const { client_id } = await svc.register({ redirect_uris: ['https://claude.ai/cb'] });
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const url = await svc.issueCode({ clientId: client_id, redirectUri: 'https://claude.ai/cb', challenge, userId: 'u9' });
    const code = new URL(url).searchParams.get('code')!;
    const tok = await svc.exchangeCode({ code, client_id, redirect_uri: 'https://claude.ai/cb', code_verifier: verifier });
    const refreshed = await svc.refresh({ refresh_token: tok.refresh_token });
    expect(OAuthService.verifyAccess(refreshed.access_token)?.sub).toBe('u9');
    expect(refreshed.scope).toBe(OAUTH_SCOPE);
    expect(OAuthService.verifyAccess('not-a-token')).toBeNull();
  });
});
