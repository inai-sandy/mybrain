import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { encryptItem as cryptoEncrypt, decryptItem as cryptoDecrypt, importAesKey, type EncryptedBlob } from './crypto';
import { buildSetup, openVault, openVaultRaw } from './flow';
import { watchIdle, AUTO_LOCK_MS } from './idle';
import { platformBiometricAvailable, enrollDevice, unlockWithDevice } from './webauthn';
import { vaultApi, type VaultMeta } from './client';

export type VaultStatus = 'loading' | 'setup' | 'locked' | 'unlocked';

type VaultCtx = {
  status: VaultStatus;
  meta: VaultMeta | null;
  refresh: () => Promise<void>;
  /** Stage 1 of setup: derive keys + generate the recovery key. Returns the recovery code to show, and a commit() to persist once the user has saved it. */
  prepareSetup: (passphrase: string) => Promise<{ recoveryDisplay: string; commit: () => Promise<void> }>;
  /** Unlock with the master passphrase OR the recovery key. Throws on a wrong secret. */
  unlock: (secret: string, mode: 'passphrase' | 'recovery') => Promise<void>;
  /** Re-verify the passphrase (re-auth) without changing the unlock state — for revealing seed phrases / private keys. */
  verifyPassphrase: (passphrase: string) => Promise<boolean>;
  lock: () => void;
  encrypt: (payload: unknown) => Promise<EncryptedBlob>;
  decrypt: <T = any>(blob: EncryptedBlob) => Promise<T>;
  // Biometric / passkey unlock.
  biometricSupported: boolean;
  enrollBiometric: (passphrase: string, label: string) => Promise<void>;
  unlockBiometric: () => Promise<void>;
};

const Ctx = createContext<VaultCtx | null>(null);

export function VaultProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<VaultStatus>('loading');
  const [meta, setMeta] = useState<VaultMeta | null>(null);
  // The unlocked vault key lives ONLY here, in memory. Never state (no accidental serialization), never storage.
  const keyRef = useRef<CryptoKey | null>(null);
  // Only offer biometrics where a real PLATFORM authenticator (Touch ID / Face ID / Windows Hello) exists.
  // The check is async, so it starts false and flips on once confirmed — never show it where it would crash/fail.
  const [bioSupported, setBioSupported] = useState(false);
  useEffect(() => {
    platformBiometricAvailable().then(setBioSupported).catch(() => setBioSupported(false));
  }, []);

  const refresh = useCallback(async () => {
    const m = await vaultApi.getMeta().catch(() => ({ setup: false }) as VaultMeta);
    setMeta(m);
    setStatus(!m.setup ? 'setup' : keyRef.current ? 'unlocked' : 'locked');
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const prepareSetup = useCallback(async (passphrase: string) => {
    const { recoveryDisplay, payload, vaultKey } = await buildSetup(passphrase);
    const commit = async () => {
      await vaultApi.createMeta(payload);
      keyRef.current = vaultKey;
      await refresh();
    };
    return { recoveryDisplay, commit };
  }, [refresh]);

  const unlock = useCallback(async (secret: string, mode: 'passphrase' | 'recovery') => {
    const m = await vaultApi.getMeta();
    if (!m.setup) throw new Error('Vault is not set up yet');
    keyRef.current = await openVault(m, secret, mode); // throws on a wrong secret
    setMeta(m);
    setStatus('unlocked');
  }, []);

  const enrollBiometric = useCallback(async (passphrase: string, label: string) => {
    const m = await vaultApi.getMeta();
    if (!m.setup) throw new Error('Vault is not set up');
    const raw = await openVaultRaw(m, passphrase, 'passphrase'); // throws on a wrong passphrase
    const device = await enrollDevice(label, raw);
    await vaultApi.addDevice(device);
  }, []);

  const unlockBiometric = useCallback(async () => {
    const devices = await vaultApi.listDevices();
    const raw = await unlockWithDevice(devices); // prompts Face ID / fingerprint
    keyRef.current = await importAesKey(raw);
    setMeta(await vaultApi.getMeta());
    setStatus('unlocked');
  }, []);

  const verifyPassphrase = useCallback(async (passphrase: string) => {
    try {
      const m = await vaultApi.getMeta();
      if (!m.setup) return false;
      await openVault(m, passphrase, 'passphrase'); // throws on a wrong passphrase
      return true;
    } catch {
      return false;
    }
  }, []);

  const lock = useCallback(() => {
    keyRef.current = null;
    setStatus((s) => (s === 'setup' || s === 'loading' ? s : 'locked'));
  }, []);

  // Auto-lock: 5 min idle wipes the in-memory key (a tab left hidden has no activity, so it
  // locks 5 min after you switch away). Also wipe on tab close/refresh. Only armed while unlocked.
  // (Logout unmounts this provider, which drops the key too.)
  useEffect(() => {
    if (status !== 'unlocked') return;
    const stopIdle = watchIdle(lock, AUTO_LOCK_MS);
    window.addEventListener('pagehide', lock);
    window.addEventListener('beforeunload', lock);
    return () => {
      stopIdle();
      window.removeEventListener('pagehide', lock);
      window.removeEventListener('beforeunload', lock);
    };
  }, [status, lock]);

  const encrypt = useCallback(async (payload: unknown) => {
    if (!keyRef.current) throw new Error('Vault is locked');
    return cryptoEncrypt(keyRef.current, payload);
  }, []);

  const decrypt = useCallback(async <T = any,>(blob: EncryptedBlob) => {
    if (!keyRef.current) throw new Error('Vault is locked');
    return cryptoDecrypt<T>(keyRef.current, blob);
  }, []);

  return (
    <Ctx.Provider value={{ status, meta, refresh, prepareSetup, unlock, verifyPassphrase, lock, encrypt, decrypt, biometricSupported: bioSupported, enrollBiometric, unlockBiometric }}>
      {children}
    </Ctx.Provider>
  );
}

export function useVault(): VaultCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useVault must be used within a VaultProvider');
  return c;
}
