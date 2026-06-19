import { describe, expect, it } from 'vitest';
import { wrapForDevice, unwrapForDevice } from './webauthn';
import { randomBytes, b64encode } from './crypto';

// The WebAuthn ceremony itself needs a real authenticator, but the security-critical part is the
// wrap/unwrap of the vault key by the device's PRF secret — that's pure crypto and testable here.
describe('biometric device key wrapping', () => {
  it('wraps the vault key with a device PRF secret and unwraps it back', async () => {
    const prfSecret = randomBytes(32);
    const vaultKey = randomBytes(32);
    const wrap = await wrapForDevice(prfSecret, vaultKey);
    expect(wrap.ct).toBeTruthy();
    expect(JSON.stringify(wrap)).not.toContain(b64encode(vaultKey));
    const back = await unwrapForDevice(prfSecret, wrap);
    expect(Array.from(back)).toEqual(Array.from(vaultKey));
  });

  it('a different device secret cannot unwrap it', async () => {
    const wrap = await wrapForDevice(randomBytes(32), randomBytes(32));
    await expect(unwrapForDevice(randomBytes(32), wrap)).rejects.toBeDefined();
  });
});
