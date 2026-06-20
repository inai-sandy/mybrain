import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Lock, ShieldCheck, Eye, EyeOff, KeyRound, Copy, Download, Check, AlertTriangle, Loader2, Plus, Fingerprint, Trash2, LayoutGrid, Rows3, ShieldAlert, Layers } from 'lucide-react';
import { copySecret } from '../vault/clipboard';
import { Sheet } from '../ui/Sheet';
import { vaultApi as vApi } from '../vault/client';
import { useToast } from '../ui/Toast';
import { useVault } from '../vault/VaultContext';
import { DataTable, type Column, type Filter, type SortOption } from '../ui/DataTable';
import { vaultApi, type VaultItemDTO } from '../vault/client';
import { VaultItemSheet } from '../vault/VaultItemSheet';
import { typeDef, itemSubtitle, COLLECTIONS, VAULT_TYPES } from '../vault/types';
import { isWeakPassword, sha256Hex } from '../vault/generator';
import { Upload, Star } from 'lucide-react';
import { parseExport, recordToItem } from '../vault/import';

type Audit = { weak?: boolean; reused?: boolean };

// ---- local passphrase strength (never leaves the browser) ----
function scorePass(s: string): { score: number; label: string; cls: string } {
  let n = 0;
  if (s.length >= 8) n++;
  if (s.length >= 14) n++;
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) n++;
  if (/\d/.test(s)) n++;
  if (/[^A-Za-z0-9]/.test(s)) n++;
  if (s.length >= 20) n++;
  const score = Math.min(4, Math.max(0, n - 1));
  const label = ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'][score];
  const cls = ['bg-red-500', 'bg-red-500', 'bg-amber-500', 'bg-emerald-500', 'bg-emerald-600'][score];
  return { score, label, cls };
}

const card = 'rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 sm:p-8';
const input =
  'w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2.5 text-sm outline-none focus:border-emerald-500';
const btn = 'rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2.5 text-sm font-medium disabled:opacity-40 transition-colors';

export function Vault() {
  const { status } = useVault();
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      {status === 'loading' && (
        <div className="flex items-center justify-center py-20 text-zinc-400">
          <Loader2 className="animate-spin" size={20} />
        </div>
      )}
      {status === 'setup' && <VaultSetup />}
      {status === 'locked' && <VaultUnlock />}
      {status === 'unlocked' && <VaultHome />}
    </div>
  );
}

// ---- first-run setup ----
function VaultSetup() {
  const { prepareSetup } = useVault();
  const toast = useToast();
  const [stage, setStage] = useState<'pass' | 'recovery'>('pass');
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState('');
  const [commit, setCommit] = useState<(() => Promise<void>) | null>(null);
  const [saved, setSaved] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const strength = scorePass(pass);

  async function toRecovery() {
    if (pass.length < 8) return toast('error', 'Use at least 8 characters');
    if (pass !== confirm) return toast('error', 'The two passphrases do not match');
    setBusy(true);
    try {
      const { recoveryDisplay, commit } = await prepareSetup(pass);
      setRecovery(recoveryDisplay);
      setCommit(() => commit);
      setStage('recovery');
    } catch {
      toast('error', 'Could not prepare the vault');
    } finally {
      setBusy(false);
    }
  }

  function download() {
    const blob = new Blob([`My Brain — Vault Recovery Key\n\nKeep this somewhere safe and private.\nIt can unlock your vault if you forget your passphrase.\n\n${recovery}\n`], {
      type: 'text/plain',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mybrain-vault-recovery-key.txt';
    a.click();
    URL.revokeObjectURL(a.href);
    setSaved(true);
  }
  async function copy() {
    await navigator.clipboard.writeText(recovery).catch(() => undefined);
    setSaved(true);
    toast('success', 'Recovery key copied');
  }

  async function finish() {
    if (!commit) return;
    setBusy(true);
    try {
      await commit();
      toast('success', 'Your vault is ready');
    } catch {
      toast('error', 'Could not create the vault');
      setBusy(false);
    }
  }

  if (stage === 'pass') {
    return (
      <div className={card}>
        <div className="flex items-center gap-3 mb-1">
          <div className="grid place-items-center h-11 w-11 rounded-xl bg-emerald-600/10 text-emerald-600">
            <ShieldCheck size={22} />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Set up your Vault</h1>
            <p className="text-sm text-zinc-500">End-to-end encrypted. Only you can ever read it.</p>
          </div>
        </div>
        <p className="text-sm text-zinc-500 my-4">
          Choose a <b>Vault Master Passphrase</b>. It is separate from your login and never leaves this device — we
          can't see it or reset it. Make it strong and memorable.
        </p>
        <label className="block text-sm text-zinc-600 dark:text-zinc-400 mb-1">Master passphrase</label>
        <div className="relative mb-2">
          <input className={input} type={show ? 'text' : 'password'} value={pass} onChange={(e) => setPass(e.target.value)} placeholder="a long phrase you'll remember" autoFocus />
          <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        {pass && (
          <div className="mb-3">
            <div className="h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
              <div className={`h-full ${strength.cls} transition-all`} style={{ width: `${((strength.score + 1) / 5) * 100}%` }} />
            </div>
            <p className="mt-1 text-xs text-zinc-500">{strength.label}</p>
          </div>
        )}
        <label className="block text-sm text-zinc-600 dark:text-zinc-400 mb-1">Confirm passphrase</label>
        <input className={`${input} mb-5`} type={show ? 'text' : 'password'} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="type it again" />
        <button className={`${btn} w-full`} onClick={toRecovery} disabled={busy || !pass || !confirm}>
          {busy ? <Loader2 className="inline animate-spin mr-2" size={15} /> : null}
          Continue
        </button>
      </div>
    );
  }

  return (
    <div className={card}>
      <div className="flex items-center gap-3 mb-4">
        <div className="grid place-items-center h-11 w-11 rounded-xl bg-amber-500/10 text-amber-500">
          <KeyRound size={22} />
        </div>
        <div>
          <h1 className="text-lg font-semibold">Save your Recovery Key</h1>
          <p className="text-sm text-zinc-500">The only way back in if you forget your passphrase.</p>
        </div>
      </div>

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 mb-4 flex gap-2 text-sm text-amber-700 dark:text-amber-300">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <span>If you lose <b>both</b> your passphrase and this key, your vault can never be recovered — not even by us. That's what keeps it private.</span>
      </div>

      <div className="rounded-xl bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 p-4 font-mono text-sm tracking-wide break-all mb-3">
        {recovery}
      </div>
      <div className="flex gap-2 mb-5">
        <button onClick={download} className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center gap-2">
          <Download size={15} /> Download
        </button>
        <button onClick={copy} className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center gap-2">
          <Copy size={15} /> Copy
        </button>
      </div>

      <label className="flex items-start gap-2.5 text-sm mb-5 cursor-pointer">
        <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-0.5 h-4 w-4 accent-emerald-600" />
        <span>I have saved my Recovery Key somewhere safe. I understand it can't be recovered if I lose it.</span>
      </label>

      <button className={`${btn} w-full`} onClick={finish} disabled={busy || !saved || !acknowledged}>
        {busy ? <Loader2 className="inline animate-spin mr-2" size={15} /> : <Check className="inline mr-2" size={15} />}
        Create my vault
      </button>
      {!saved && <p className="mt-2 text-center text-xs text-zinc-400">Download or copy your key first.</p>}
    </div>
  );
}

// ---- unlock (passphrase OR recovery key) ----
function VaultUnlock() {
  const { unlock, unlockBiometric, biometricSupported } = useVault();
  const toast = useToast();
  const [mode, setMode] = useState<'passphrase' | 'recovery'>('passphrase');
  const [secret, setSecret] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  // Came in via a deep-link (/vault?item=…) from search/chat — tell the user it'll open after unlock.
  const [sp] = useSearchParams();
  const deepLinked = !!sp.get('item');

  async function go() {
    if (!secret.trim()) return;
    setBusy(true);
    try {
      await unlock(secret.trim(), mode);
      setSecret('');
    } catch {
      toast('error', mode === 'passphrase' ? 'Wrong passphrase' : 'That recovery key did not work');
      setBusy(false);
    }
  }

  async function bio() {
    try {
      await unlockBiometric();
    } catch (e: any) {
      toast('error', e?.message?.includes('No biometric') ? 'No biometric set up yet — unlock once, then enable it' : 'Biometric unlock failed');
    }
  }

  return (
    <div className={card}>
      <div className="flex items-center gap-3 mb-4">
        <div className="grid place-items-center h-11 w-11 rounded-xl bg-emerald-600/10 text-emerald-600">
          <Lock size={22} />
        </div>
        <div>
          <h1 className="text-lg font-semibold">Vault locked</h1>
          <p className="text-sm text-zinc-500">{deepLinked ? 'Unlock to open the item you selected.' : 'Unlock with your passphrase to view your secrets.'}</p>
        </div>
      </div>

      {mode === 'passphrase' ? (
        <>
          <label className="block text-sm text-zinc-600 dark:text-zinc-400 mb-1">Master passphrase</label>
          <div className="relative mb-4">
            <input className={input} type={show ? 'text' : 'password'} value={secret} onChange={(e) => setSecret(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} autoFocus placeholder="your vault passphrase" />
            <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </>
      ) : (
        <>
          <label className="block text-sm text-zinc-600 dark:text-zinc-400 mb-1">Recovery key</label>
          <textarea className={`${input} mb-4 font-mono`} rows={3} value={secret} onChange={(e) => setSecret(e.target.value)} autoFocus placeholder="XXXXX-XXXXX-…" />
        </>
      )}

      <button className={`${btn} w-full`} onClick={go} disabled={busy || !secret.trim()}>
        {busy ? <Loader2 className="inline animate-spin mr-2" size={15} /> : null}
        Unlock
      </button>
      {biometricSupported && mode === 'passphrase' && (
        <button onClick={bio} className="mt-3 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center gap-2">
          <Fingerprint size={16} className="text-emerald-600" /> Unlock with biometrics
        </button>
      )}
      <button
        onClick={() => {
          setMode((m) => (m === 'passphrase' ? 'recovery' : 'passphrase'));
          setSecret('');
        }}
        className="mt-3 w-full text-center text-xs text-zinc-500 hover:text-emerald-600"
      >
        {mode === 'passphrase' ? 'Forgot it? Use your Recovery Key' : 'Use my passphrase instead'}
      </button>
    </div>
  );
}

// ---- unlocked landing: the item list + CRUD (BEA-348) ----
function VaultHome() {
  const { lock, decrypt, encrypt, biometricSupported } = useVault();
  const [rows, setRows] = useState<VaultItemDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<VaultItemDTO | null>(null);
  const [creating, setCreating] = useState(false);
  const [audit, setAudit] = useState<Record<string, Audit>>({});
  const [bioOpen, setBioOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // Deep-link from global search (/vault?item=<id>) — open that item once the vault is unlocked + loaded.
  const [searchParams, setSearchParams] = useSearchParams();

  async function exportVault() {
    const items = await vaultApi.listAll(); // ALL items, not just the first page (BEA-390)
    // The blobs are already ciphertext — this backup is only readable with your vault key.
    const data = { app: 'mybrain-vault', exportedAt: new Date().toISOString(), items };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mybrain-vault-backup.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function refresh() {
    setLoading(true);
    try {
      const items = await vaultApi.listAll(); // every item (paged) — metadata + ciphertext only (BEA-390)
      setRows(items);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  // Open the deep-linked item (from global search), then clear the param so re-locking won't reopen it.
  const wantItem = searchParams.get('item');
  useEffect(() => {
    if (!wantItem || loading) return;
    const found = rows.find((r) => r.id === wantItem);
    if (found) setEditing(found);
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantItem, loading, rows]);

  // Local password health: decrypt logins in-memory, flag weak + reused (by hash, never storing the plaintext).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const logins = rows.filter((r) => r.type === 'login');
      const got = await Promise.all(
        logins.map(async (r) => {
          try {
            const s = await decrypt<Record<string, string>>(r.blob);
            return { id: r.id, pw: s.password || '' };
          } catch {
            return { id: r.id, pw: '' };
          }
        }),
      );
      const hashes: Record<string, string> = {};
      const counts: Record<string, number> = {};
      for (const g of got) {
        if (!g.pw) continue;
        const h = await sha256Hex(g.pw);
        hashes[g.id] = h;
        counts[h] = (counts[h] || 0) + 1;
      }
      if (cancelled) return;
      const map: Record<string, Audit> = {};
      for (const g of got) {
        if (!g.pw) continue;
        map[g.id] = { weak: isWeakPassword(g.pw), reused: counts[hashes[g.id]] > 1 };
      }
      setAudit(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [rows, decrypt]);

  const toast = useToast();
  // Card/table view, remembered per device (default table — fastest to scan a big vault). (BEA-391)
  const [view, setView] = useState<'table' | 'cards'>(() => (localStorage.getItem('vault.view') === 'cards' ? 'cards' : 'table'));
  useEffect(() => { localStorage.setItem('vault.view', view); }, [view]);
  // Active type tab.
  const [tab, setTab] = useState<string>('all');

  async function toggleFav(it: VaultItemDTO) {
    setRows((rs) => rs.map((r) => (r.id === it.id ? { ...r, favorite: !r.favorite } : r)));
    await vaultApi.setFavorite(it.id, !it.favorite).catch(() => refresh());
  }
  // Inline copy — never opens the item; clipboard auto-clears in 30s; audit-logged.
  async function copyUsername(it: VaultItemDTO) {
    if (!it.username) return;
    await copySecret(it.username);
    vaultApi.addAudit(it.id, 'copied');
    toast('success', 'Username copied — clears in 30s');
  }
  async function copyPassword(it: VaultItemDTO) {
    try {
      const s = await decrypt<Record<string, string>>(it.blob); // decrypts in-browser only
      const pw = s.password || '';
      if (!pw) return toast('error', 'No password on this item');
      await copySecret(pw);
      vaultApi.addAudit(it.id, 'copied');
      toast('success', 'Password copied — clears in 30s');
    } catch {
      toast('error', 'Could not copy');
    }
  }
  const hasQuickPassword = (t: string) => t === 'login' || t === 'wifi';

  // Local security summary (all derived in-memory, nothing leaves the browser).
  const total = rows.length;
  const weakCount = Object.values(audit).filter((a) => a.weak).length;
  const reusedCount = Object.values(audit).filter((a) => a.reused).length;
  const favCount = rows.filter((r) => r.favorite).length;
  const allHealthy = !loading && total > 0 && weakCount === 0 && reusedCount === 0;
  const iconBtn = 'rounded-lg border border-zinc-300 dark:border-zinc-700 p-2 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:border-zinc-400 dark:hover:border-zinc-600 transition-colors';

  // ---- Tabs: All · ★ Favorites · ⚠ Security (if any) · then each type that has items. ----
  const typeCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows) m[r.type] = (m[r.type] || 0) + 1;
    return m;
  }, [rows]);
  const securityIds = useMemo(() => new Set(Object.entries(audit).filter(([, a]) => a.weak || a.reused).map(([id]) => id)), [audit]);
  const tabs = useMemo(() => {
    const list: { key: string; icon: typeof Layers; label: string; count: number }[] = [
      { key: 'all', icon: Layers, label: 'All items', count: total },
      { key: 'fav', icon: Star, label: 'Favorites', count: favCount },
    ];
    if (securityIds.size > 0) list.push({ key: 'security', icon: ShieldAlert, label: 'Needs attention', count: securityIds.size });
    for (const t of VAULT_TYPES) if (typeCounts[t.type]) list.push({ key: t.type, icon: t.icon, label: t.label, count: typeCounts[t.type] });
    return list;
  }, [rows, total, favCount, securityIds, typeCounts]);
  const activeTab = tabs.find((t) => t.key === tab) || tabs[0];
  // If the active tab disappears (last item of a type deleted, or Security cleared), fall back to All.
  useEffect(() => {
    if (!tabs.some((t) => t.key === tab)) setTab('all');
  }, [tabs, tab]);
  const tabRows = useMemo(() => {
    if (tab === 'all') return rows;
    if (tab === 'fav') return rows.filter((r) => r.favorite);
    if (tab === 'security') return rows.filter((r) => securityIds.has(r.id));
    return rows.filter((r) => r.type === tab);
  }, [rows, tab, securityIds]);

  const cellBtn = 'text-zinc-400 hover:text-emerald-600 transition-colors';
  // Table columns (BEA-391). Metadata only in the table; the password is copied via decrypt, never shown.
  const columns: Column<VaultItemDTO>[] = [
    {
      key: 'title', label: 'Name', sortable: true,
      render: (r) => (
        <div className="flex items-center gap-2.5 min-w-0">
          <LetterAvatar name={r.title || r.website || '?'} type={r.type} />
          <span className="font-medium truncate max-w-[200px]">{r.title || 'Untitled'}</span>
        </div>
      ),
    },
    {
      key: 'username', label: 'Username',
      render: (r) => (r.username ? (
        <span className="inline-flex items-center gap-1.5 text-zinc-600 dark:text-zinc-300">
          <span className="truncate max-w-[160px]">{r.username}</span>
          <button onClick={(e) => { e.stopPropagation(); copyUsername(r); }} title="Copy username" className={cellBtn}><Copy size={13} /></button>
        </span>
      ) : <span className="text-zinc-300 dark:text-zinc-600">—</span>),
    },
    {
      key: 'website', label: 'Website',
      render: (r) => (r.website ? <span className="text-zinc-500 truncate max-w-[180px] inline-block align-bottom">{r.website}</span> : <span className="text-zinc-300 dark:text-zinc-600">—</span>),
    },
    {
      key: 'collection', label: '',
      render: (r) => (
        <div className="flex items-center gap-1.5">
          {audit[r.id]?.weak ? <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">Weak</span> : audit[r.id]?.reused ? <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">Reused</span> : null}
          {r.collection && <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500">{r.collection}</span>}
        </div>
      ),
    },
    {
      key: 'id', label: '', align: 'right',
      render: (r) => (
        <div className="flex items-center justify-end gap-2">
          {hasQuickPassword(r.type) && <button onClick={(e) => { e.stopPropagation(); copyPassword(r); }} title="Copy password" className={cellBtn}><KeyRound size={14} /></button>}
          <button onClick={(e) => { e.stopPropagation(); toggleFav(r); }} title={r.favorite ? 'Unpin' : 'Pin'} className="text-zinc-300 dark:text-zinc-600 hover:text-amber-500 transition-colors"><Star size={14} className={r.favorite ? 'fill-amber-400 text-amber-400' : ''} /></button>
        </div>
      ),
    },
  ];
  const filters: Filter[] = [
    { key: 'collection', label: 'Collection', options: COLLECTIONS.map((c) => ({ value: c, label: c })), match: (r, v) => r.collection === v },
  ];
  const sortOptions: SortOption[] = [
    { label: 'Newest', key: 'createdAt', dir: -1 },
    { label: 'Oldest', key: 'createdAt', dir: 1 },
    { label: 'Name', key: 'title', dir: 1 },
  ];

  return (
    <div className="-mt-2">
      {/* Header card — status + security summary */}
      <div className="rounded-2xl border border-emerald-200/70 dark:border-emerald-900/50 bg-gradient-to-br from-emerald-50 to-white dark:from-emerald-950/30 dark:to-zinc-900 p-4 sm:p-5 mb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="grid place-items-center h-11 w-11 shrink-0 rounded-xl bg-emerald-600/15 text-emerald-600">
              <ShieldCheck size={22} />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold leading-tight">Vault</h1>
              <p className="text-sm text-zinc-500">
                {loading ? 'Loading…' : total === 0 ? 'Unlocked · empty' : `Unlocked · ${total} item${total === 1 ? '' : 's'}`}
              </p>
            </div>
          </div>
          <button onClick={lock} className="shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-white/70 dark:hover:bg-zinc-800 flex items-center gap-1.5 transition-colors">
            <Lock size={14} /> Lock
          </button>
        </div>
        {total > 0 && (
          <div className="flex flex-wrap items-center gap-2 mt-3">
            {allHealthy && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-xs px-2.5 py-1">
                <ShieldCheck size={12} /> All passwords strong
              </span>
            )}
            {weakCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 text-xs px-2.5 py-1">
                <AlertTriangle size={12} /> {weakCount} weak
              </span>
            )}
            {reusedCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 text-xs px-2.5 py-1">
                <AlertTriangle size={12} /> {reusedCount} reused
              </span>
            )}
            {favCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 text-xs px-2.5 py-1">
                <Star size={12} className="fill-amber-400 text-amber-400" /> {favCount} pinned
              </span>
            )}
            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 text-xs px-2.5 py-1">
              <Lock size={11} /> Auto-locks when idle
            </span>
          </div>
        )}
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-2 mb-4">
        <button onClick={() => setCreating(true)} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 text-sm font-medium flex items-center gap-1.5 transition-colors">
          <Plus size={16} /> Add item
        </button>
        <div className="flex-1" />
        <button onClick={() => setImportOpen(true)} title="Import" aria-label="Import" className={iconBtn}>
          <Upload size={16} />
        </button>
        <button onClick={exportVault} title="Export encrypted backup" aria-label="Export encrypted backup" className={iconBtn}>
          <Download size={16} />
        </button>
        {biometricSupported && (
          <button onClick={() => setBioOpen(true)} title="Biometric unlock" aria-label="Biometric unlock" className={iconBtn}>
            <Fingerprint size={16} />
          </button>
        )}
      </div>
      {bioOpen && <BiometricSheet onClose={() => setBioOpen(false)} />}

      {/* Sticky icon-only type tabs + view toggle (BEA-391) */}
      <div className="sticky top-0 z-20 -mx-4 px-4 py-2 mb-2 bg-white/85 dark:bg-zinc-950/85 backdrop-blur border-b border-zinc-200/60 dark:border-zinc-800/60">
        <div className="flex items-center gap-2">
          <div className="flex-1 flex gap-1 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
            {tabs.map((t) => {
              const on = tab === t.key;
              const warn = t.key === 'security';
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  title={`${t.label}${t.count ? ` · ${t.count}` : ''}`}
                  aria-label={t.label}
                  className={'relative shrink-0 grid place-items-center h-10 w-11 rounded-lg transition-colors ' + (on ? (warn ? 'bg-amber-500 text-white' : 'bg-emerald-600 text-white') : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800')}
                >
                  <t.icon size={18} />
                  {t.count > 0 && (
                    <span className={'absolute -top-1 -right-0.5 min-w-[16px] h-4 px-1 rounded-full text-[10px] font-medium grid place-items-center ' + (on ? 'bg-white ' + (warn ? 'text-amber-600' : 'text-emerald-700') : (warn ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400' : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300'))}>
                      {t.count > 999 ? '999+' : t.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="flex shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 overflow-hidden">
            <button onClick={() => setView('table')} title="Table view" aria-label="Table view" className={'p-2 transition-colors ' + (view === 'table' ? 'bg-emerald-600 text-white' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800')}><Rows3 size={16} /></button>
            <button onClick={() => setView('cards')} title="Card view" aria-label="Card view" className={'p-2 transition-colors ' + (view === 'cards' ? 'bg-emerald-600 text-white' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800')}><LayoutGrid size={16} /></button>
          </div>
        </div>
      </div>

      {/* Active tab heading — keeps the icon-only tabs unambiguous */}
      <div className="flex items-center gap-2 mb-2">
        <activeTab.icon size={16} className={tab === 'security' ? 'text-amber-500' : 'text-emerald-600'} />
        <h2 className="font-semibold">{activeTab.label}</h2>
        <span className="text-sm text-zinc-400 tabular-nums">· {tabRows.length}</span>
      </div>

      {view === 'table' ? (
        <DataTable
          key="table"
          columns={columns}
          rows={tabRows}
          loading={loading}
          filters={filters}
          sortOptions={sortOptions}
          pageSize={15}
          emptyText={tab === 'fav' ? 'No pinned items yet — tap the ☆ on any item to pin it.' : tab === 'security' ? 'No weak or reused passwords. 🎉' : 'Nothing here yet.'}
          onRowClick={(it) => setEditing(it)}
        />
      ) : (
        <DataTable
          key="cards"
          columns={columns}
          rows={tabRows}
          loading={loading}
          filters={filters}
          sortOptions={sortOptions}
          pageSize={12}
          cardsOnly
          gridClassName="grid grid-cols-1 sm:grid-cols-2 gap-3"
          emptyText={tab === 'fav' ? 'No pinned items yet — tap the ☆ on any item to pin it.' : tab === 'security' ? 'No weak or reused passwords. 🎉' : 'Your vault is empty. Tap “Add” to store your first item.'}
          renderCard={(it) => <ItemCard key={it.id} item={it} audit={audit[it.id]} onClick={() => setEditing(it)} onFav={() => toggleFav(it)} onCopyUser={() => copyUsername(it)} onCopyPass={() => copyPassword(it)} quickPass={hasQuickPassword(it.type)} />}
        />
      )}

      {creating && <VaultItemSheet defaultType="login" onClose={() => setCreating(false)} onSaved={refresh} />}
      {editing && <VaultItemSheet item={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {importOpen && <ImportSheet encrypt={encrypt} onClose={() => setImportOpen(false)} onDone={refresh} />}
    </div>
  );
}

function ImportSheet({ encrypt, onClose, onDone }: { encrypt: (p: unknown) => Promise<any>; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [records, setRecords] = useState<ReturnType<typeof parseExport>>([]);
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);

  async function pick(file: File) {
    const text = await file.text();
    const recs = parseExport(file.name, text);
    setFilename(file.name);
    setRecords(recs);
    if (!recs.length) toast('error', 'No items found in that file');
  }

  async function run(close: () => void) {
    setBusy(true);
    try {
      let n = 0;
      for (const rec of records) {
        const { type, metadata, secret } = recordToItem(rec);
        const blob = await encrypt(secret); // each record encrypted in the browser before upload
        await vaultApi.create({ type, blob, ...metadata } as any);
        setDone(++n);
      }
      toast('success', `Imported ${n} item${n === 1 ? '' : 's'}`);
      onDone();
      close();
    } catch {
      toast('error', 'Import failed partway — some items may have been added');
      onDone();
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={onClose} canClose={() => !busy}>
      {(close) => (
        <div>
          <div className="flex items-center gap-2.5 mb-3">
            <div className="grid place-items-center h-9 w-9 shrink-0 rounded-xl bg-emerald-600/10 text-emerald-600">
              <Upload size={18} />
            </div>
            <div>
              <h2 className="font-semibold leading-tight">Import</h2>
              <p className="text-xs text-zinc-500">Bitwarden · 1Password · CSV</p>
            </div>
          </div>
          <p className="text-sm text-zinc-500 mb-4">Everything is encrypted in your browser before it's saved — nothing is uploaded in plain text.</p>

          <label className="block cursor-pointer text-center py-5 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 text-sm text-zinc-500 hover:text-emerald-600 mb-3">
            <input type="file" accept=".json,.csv,.txt" className="hidden" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
            <Upload size={18} className="mx-auto mb-1" />
            {filename ? `${filename} — ${records.length} item(s)` : 'Choose an export file (.json / .csv)'}
          </label>

          {records.length > 0 && (
            <button onClick={() => run(close)} disabled={busy} className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2.5 text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-2">
              {busy ? <><Loader2 className="animate-spin" size={15} /> Importing {done}/{records.length}…</> : <><Check size={15} /> Import {records.length} item{records.length === 1 ? '' : 's'}</>}
            </button>
          )}
        </div>
      )}
    </Sheet>
  );
}

function BiometricSheet({ onClose }: { onClose: () => void }) {
  const { enrollBiometric } = useVault();
  const toast = useToast();
  const [devices, setDevices] = useState<{ id: string; label: string; createdAt: string }[]>([]);
  const [pass, setPass] = useState('');
  const [label, setLabel] = useState('This device');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setDevices(await vApi.listDevices().catch(() => []));
  }
  useEffect(() => {
    refresh();
  }, []);

  async function enroll() {
    if (!pass) return toast('error', 'Enter your passphrase to enable biometrics');
    setBusy(true);
    try {
      await enrollBiometric(pass, label.trim() || 'This device');
      toast('success', 'Biometric unlock enabled on this device');
      setPass('');
      await refresh();
    } catch (e: any) {
      toast('error', e?.message?.includes('PRF') ? "This device/browser doesn't support biometric vault unlock" : e?.message?.includes('verify') || e?.message?.includes('wrap') ? 'Wrong passphrase' : 'Could not enable biometrics');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    await vApi.removeDevice(id).catch(() => undefined);
    toast('success', 'Device removed');
    refresh();
  }

  const inp = 'w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2.5 text-sm outline-none focus:border-emerald-500';
  return (
    <Sheet onClose={onClose} canClose={() => !busy}>
      {() => (
        <div>
          <div className="flex items-center gap-2.5 mb-3">
            <div className="grid place-items-center h-9 w-9 shrink-0 rounded-xl bg-emerald-600/10 text-emerald-600">
              <Fingerprint size={18} />
            </div>
            <div>
              <h2 className="font-semibold leading-tight">Biometric unlock</h2>
              <p className="text-xs text-zinc-500">Face ID / Touch ID on this device</p>
            </div>
          </div>
          <p className="text-sm text-zinc-500 mb-4">Your passphrase stays the master key and is still required here.</p>

          {devices.length > 0 && (
            <div className="space-y-2 mb-4">
              {devices.map((d) => (
                <div key={d.id} className="flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-2">
                  <Fingerprint size={15} className="text-zinc-400" />
                  <span className="text-sm flex-1 truncate">{d.label}</span>
                  <button onClick={() => revoke(d.id)} className="text-red-500 hover:text-red-600"><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          )}

          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 space-y-2">
            <p className="text-xs font-medium text-zinc-500">Enable on this device</p>
            <input className={inp} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Device name (e.g. iPhone)" />
            <input className={inp} type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Confirm with your passphrase" />
            <button onClick={enroll} disabled={busy} className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-2">
              {busy ? <Loader2 className="animate-spin" size={14} /> : <Fingerprint size={14} />} Enable biometric unlock
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

// Local, privacy-safe letter avatar (no external favicons) + a small type-icon badge. (BEA-391)
const AVATAR_COLORS = ['bg-emerald-500', 'bg-blue-500', 'bg-violet-500', 'bg-amber-500', 'bg-rose-500', 'bg-teal-500', 'bg-indigo-500', 'bg-pink-500', 'bg-cyan-600', 'bg-orange-500', 'bg-fuchsia-500', 'bg-sky-500'];
function LetterAvatar({ name, type }: { name: string; type: string }) {
  const def = typeDef(type);
  const clean = (name || '').trim();
  const letter = clean ? clean.charAt(0).toUpperCase() : '?';
  let h = 0;
  for (let i = 0; i < clean.length; i++) h = (h * 31 + clean.charCodeAt(i)) >>> 0;
  const color = AVATAR_COLORS[h % AVATAR_COLORS.length];
  return (
    <div className="relative shrink-0">
      <div className={`h-9 w-9 rounded-lg grid place-items-center text-white text-sm font-semibold ${color}`}>{letter}</div>
      <div className="absolute -bottom-1 -right-1 h-4 w-4 rounded-md bg-white dark:bg-zinc-900 ring-1 ring-zinc-200 dark:ring-zinc-700 grid place-items-center text-zinc-500">
        <def.icon size={9} />
      </div>
    </div>
  );
}

function ItemCard({ item, audit, onClick, onFav, onCopyUser, onCopyPass, quickPass }: { item: VaultItemDTO; audit?: Audit; onClick: () => void; onFav: () => void; onCopyUser: () => void; onCopyPass: () => void; quickPass: boolean }) {
  const def = typeDef(item.type);
  const sub = itemSubtitle(item);
  const warn = audit?.weak ? 'Weak' : audit?.reused ? 'Reused' : '';
  const stop = (fn: () => void) => (e: { stopPropagation: () => void }) => { e.stopPropagation(); fn(); };
  return (
    <div
      onClick={onClick}
      className="group relative w-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-emerald-400 dark:hover:border-emerald-700 hover:shadow-sm transition-all cursor-pointer p-3.5 active:scale-[0.99]"
    >
      <div className="flex items-center gap-3">
        <LetterAvatar name={item.title || item.website || '?'} type={item.type} />
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate pr-6">{item.title || 'Untitled'}</div>
          <div className="text-xs text-zinc-500 truncate">{sub || def.label}</div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {warn && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center gap-1">
              <AlertTriangle size={10} /> {warn}
            </span>
          )}
          {item.collection && <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500">{item.collection}</span>}
        </div>
      </div>
      {(item.username || quickPass) && (
        <div className="flex items-center gap-1.5 mt-2.5 ml-12">
          {item.username && (
            <button onClick={stop(onCopyUser)} className="inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-[11px] text-zinc-500 hover:text-emerald-600 hover:border-emerald-400 transition-colors">
              <Copy size={11} /> User
            </button>
          )}
          {quickPass && (
            <button onClick={stop(onCopyPass)} className="inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-[11px] text-zinc-500 hover:text-emerald-600 hover:border-emerald-400 transition-colors">
              <KeyRound size={11} /> Password
            </button>
          )}
        </div>
      )}
      <button onClick={stop(onFav)} title={item.favorite ? 'Unpin' : 'Pin'} aria-label={item.favorite ? 'Unpin' : 'Pin'} className="absolute top-2 right-2 p-1 text-zinc-300 dark:text-zinc-600 hover:text-amber-500 transition-colors">
        <Star size={14} className={item.favorite ? 'fill-amber-400 text-amber-400' : ''} />
      </button>
    </div>
  );
}
