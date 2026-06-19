import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { encryptItem as cryptoEncrypt, decryptItem as cryptoDecrypt, type EncryptedBlob } from './crypto';
import { buildSetup, openVault } from './flow';
import { watchIdle, AUTO_LOCK_MS } from './idle';
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
  lock: () => void;
  encrypt: (payload: unknown) => Promise<EncryptedBlob>;
  decrypt: <T = any>(blob: EncryptedBlob) => Promise<T>;
};

const Ctx = createContext<VaultCtx | null>(null);

export function VaultProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<VaultStatus>('loading');
  const [meta, setMeta] = useState<VaultMeta | null>(null);
  // The unlocked vault key lives ONLY here, in memory. Never state (no accidental serialization), never storage.
  const keyRef = useRef<CryptoKey | null>(null);

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

  return <Ctx.Provider value={{ status, meta, refresh, prepareSetup, unlock, lock, encrypt, decrypt }}>{children}</Ctx.Provider>;
}

export function useVault(): VaultCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useVault must be used within a VaultProvider');
  return c;
}
