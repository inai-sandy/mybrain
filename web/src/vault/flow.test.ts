import { describe, expect, it } from 'vitest';
import { buildSetup, openVault } from './flow';
import { encryptItem, decryptItem } from './crypto';

describe('vault setup → unlock flow', () => {
  it('sets up, then unlocks with the passphrase, the recovery key, but NOT a wrong passphrase', async () => {
    const PASS = 'a strong vault passphrase 2026';
    const { recoveryDisplay, payload } = await buildSetup(PASS);

    // The payload that goes to the server is ciphertext only — no passphrase, no recovery key in the clear.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(PASS);
    expect(serialized).not.toContain(recoveryDisplay);
    expect(payload.wrapPass.ct).toBeTruthy();
    expect(payload.wrapRecovery.ct).toBeTruthy();

    const meta = { ...payload };

    // passphrase unlocks, and the resulting key can decrypt a freshly-encrypted item
    const k1 = await openVault(meta, PASS, 'passphrase');
    const blob = await encryptItem(k1, { password: 'top-secret' });
    expect(await decryptItem(k1, blob)).toEqual({ password: 'top-secret' });

    // recovery key ALONE unlocks to the same vault key (can read what the passphrase wrote)
    const k2 = await openVault(meta, recoveryDisplay, 'recovery');
    expect(await decryptItem(k2, blob)).toEqual({ password: 'top-secret' });

    // wrong passphrase fails
    await expect(openVault(meta, 'WRONG passphrase', 'passphrase')).rejects.toBeDefined();
    // a malformed recovery key fails
    await expect(openVault(meta, 'AAAAA-BBBBB-CCCCC', 'recovery')).rejects.toBeDefined();
  });
});
