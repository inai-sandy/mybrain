import { describe, expect, it } from 'vitest';
import { wrapForDevice, unwrapForDevice, biometricSupported, platformBiometricAvailable } from './webauthn';
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

describe('biometric capability gate', () => {
  it('reports no platform authenticator when WebAuthn is unavailable (and never throws)', async () => {
    // jsdom has no PublicKeyCredential, so both gates must be false — and the async gate must resolve,
    // not reject. This is what keeps the biometric button hidden where it would otherwise crash.
    expect(biometricSupported()).toBe(false);
    await expect(platformBiometricAvailable()).resolves.toBe(false);
  });

  it('resolves false (never rejects) even when the platform check throws', async () => {
    const w = window as any;
    const origPKC = w.PublicKeyCredential;
    const origCreds = navigator.credentials;
    // Make biometricSupported() pass so we actually reach — and swallow — the throwing platform probe.
    w.PublicKeyCredential = { isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.reject(new Error('boom')) };
    Object.defineProperty(navigator, 'credentials', { value: { create: () => undefined }, configurable: true });
    try {
      await expect(platformBiometricAvailable()).resolves.toBe(false);
    } finally {
      w.PublicKeyCredential = origPKC;
      Object.defineProperty(navigator, 'credentials', { value: origCreds, configurable: true });
    }
  });
});
