import { useEffect, useState } from 'react';
import { Lock, ShieldCheck, Eye, EyeOff, KeyRound, Copy, Download, Check, AlertTriangle, Loader2, Plus } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { useVault } from '../vault/VaultContext';
import { DataTable, type Column, type Filter, type SortOption } from '../ui/DataTable';
import { vaultApi, type VaultItemDTO } from '../vault/client';
import { VaultItemSheet } from '../vault/VaultItemSheet';
import { typeDef, itemSubtitle, COLLECTIONS, VAULT_TYPES } from '../vault/types';
import { isWeakPassword, sha256Hex } from '../vault/generator';

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
    <div className="mx-auto max-w-xl px-4 py-8">
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
  const { unlock } = useVault();
  const toast = useToast();
  const [mode, setMode] = useState<'passphrase' | 'recovery'>('passphrase');
  const [secret, setSecret] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

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

  return (
    <div className={card}>
      <div className="flex items-center gap-3 mb-4">
        <div className="grid place-items-center h-11 w-11 rounded-xl bg-emerald-600/10 text-emerald-600">
          <Lock size={22} />
        </div>
        <div>
          <h1 className="text-lg font-semibold">Vault locked</h1>
          <p className="text-sm text-zinc-500">Unlock with your passphrase to view your secrets.</p>
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
  const { lock, decrypt } = useVault();
  const [rows, setRows] = useState<VaultItemDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<VaultItemDTO | null>(null);
  const [creating, setCreating] = useState(false);
  const [audit, setAudit] = useState<Record<string, Audit>>({});

  async function refresh() {
    setLoading(true);
    try {
      const r = await vaultApi.list({ pageSize: 1000 }); // list is metadata + ciphertext only
      setRows(r.items);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    refresh();
  }, []);

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

  // Search runs over METADATA columns only — the encrypted blob is never a column, so it can't be searched.
  const columns: Column<VaultItemDTO>[] = [
    { key: 'title', label: 'Name' },
    { key: 'username', label: 'Username' },
    { key: 'website', label: 'Website' },
    { key: 'tags', label: 'Tags' },
  ];
  const filters: Filter[] = [
    { key: 'type', label: 'Type', options: VAULT_TYPES.map((t) => ({ value: t.type, label: t.label })), match: (r, v) => r.type === v },
    { key: 'collection', label: 'Collection', options: COLLECTIONS.map((c) => ({ value: c, label: c })), match: (r, v) => r.collection === v },
  ];
  const sortOptions: SortOption[] = [
    { label: 'Newest', key: 'createdAt', dir: -1 },
    { label: 'Oldest', key: 'createdAt', dir: 1 },
    { label: 'Name', key: 'title', dir: 1 },
  ];

  return (
    <div className="-mt-2">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <ShieldCheck size={20} className="text-emerald-600" />
          <h1 className="text-lg font-semibold">Vault</h1>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setCreating(true)} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm flex items-center gap-1.5">
            <Plus size={15} /> Add
          </button>
          <button onClick={lock} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1.5">
            <Lock size={14} /> Lock
          </button>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        filters={filters}
        sortOptions={sortOptions}
        pageSize={12}
        cardsOnly
        gridClassName="grid grid-cols-1 sm:grid-cols-2 gap-3"
        emptyText="Your vault is empty. Tap “Add” to store your first login."
        renderCard={(it) => <ItemCard key={it.id} item={it} audit={audit[it.id]} onClick={() => setEditing(it)} />}
      />

      {creating && <VaultItemSheet defaultType="login" onClose={() => setCreating(false)} onSaved={refresh} />}
      {editing && <VaultItemSheet item={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  );
}

function ItemCard({ item, audit, onClick }: { item: VaultItemDTO; audit?: Audit; onClick: () => void }) {
  const def = typeDef(item.type);
  const sub = itemSubtitle(item);
  const warn = audit?.weak ? 'Weak' : audit?.reused ? 'Reused' : '';
  return (
    <button onClick={onClick} className="text-left w-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 hover:border-emerald-400 dark:hover:border-emerald-700 transition-colors flex items-center gap-3">
      <div className="grid place-items-center h-10 w-10 shrink-0 rounded-lg bg-emerald-600/10 text-emerald-600">
        <def.icon size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium truncate">{item.title || 'Untitled'}</div>
        {sub && <div className="text-xs text-zinc-500 truncate">{sub}</div>}
      </div>
      {warn && (
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 shrink-0 flex items-center gap-1">
          <AlertTriangle size={10} /> {warn}
        </span>
      )}
      {item.collection && <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 shrink-0">{item.collection}</span>}
    </button>
  );
}
