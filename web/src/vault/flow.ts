// Pure setup/unlock orchestration — no React, no network — so it can be unit-tested directly.
import {
  DEFAULT_KDF,
  b64encode,
  b64decode,
  randomBytes,
  deriveMasterKey,
  importAesKey,
  wrapVaultKey,
  unwrapVaultKeyRaw,
  makeVerifier,
  checkVerifier,
  generateRecoveryKey,
  recoveryKeyToBytes,
  type Cipher,
  type KdfParams,
} from './crypto';

export type MetaPayload = { kdfParams: KdfParams; salt: string; verifier: Cipher; wrapPass: Cipher; wrapRecovery: Cipher };

/** Build a brand-new vault: derive everything client-side and return the payload to POST + the live key. */
export async function buildSetup(passphrase: string): Promise<{ recoveryDisplay: string; payload: MetaPayload; vaultKey: CryptoKey }> {
  const salt = randomBytes(16);
  const vaultKeyRaw = randomBytes(32);
  const masterKey = await deriveMasterKey(passphrase, salt, DEFAULT_KDF);
  const recovery = generateRecoveryKey();
  const recoveryKey = await importAesKey(recovery.bytes);

  const wrapPass = await wrapVaultKey(masterKey, vaultKeyRaw);
  const wrapRecovery = await wrapVaultKey(recoveryKey, vaultKeyRaw);
  const vaultKey = await importAesKey(vaultKeyRaw);
  const verifier = await makeVerifier(vaultKey);

  return {
    recoveryDisplay: recovery.display,
    payload: { kdfParams: DEFAULT_KDF, salt: b64encode(salt), verifier, wrapPass, wrapRecovery },
    vaultKey,
  };
}

export type UnlockMeta = { kdfParams: KdfParams; salt: string; verifier: Cipher; wrapPass: Cipher; wrapRecovery: Cipher };

/** Unlock with the master passphrase OR the recovery key. Throws on a wrong secret / failed verifier. */
export async function openVault(meta: UnlockMeta, secret: string, mode: 'passphrase' | 'recovery'): Promise<CryptoKey> {
  const salt = b64decode(meta.salt);
  let vaultKeyRaw: Uint8Array;
  if (mode === 'passphrase') {
    const masterKey = await deriveMasterKey(secret, salt, meta.kdfParams);
    vaultKeyRaw = await unwrapVaultKeyRaw(masterKey, meta.wrapPass);
  } else {
    const recoveryKey = await importAesKey(recoveryKeyToBytes(secret));
    vaultKeyRaw = await unwrapVaultKeyRaw(recoveryKey, meta.wrapRecovery);
  }
  const vaultKey = await importAesKey(vaultKeyRaw);
  if (!(await checkVerifier(vaultKey, meta.verifier))) throw new Error('Could not verify the vault key');
  return vaultKey;
}
