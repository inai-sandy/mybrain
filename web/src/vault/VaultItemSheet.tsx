import { useEffect, useState } from 'react';
import { Eye, EyeOff, Copy, Trash2, Loader2, Check, Wand2, RefreshCw } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';
import { useVault } from './VaultContext';
import { vaultApi, type VaultItemDTO } from './client';
import { typeDef, splitForm, mergeForm, COLLECTIONS, VAULT_TYPES, type FormValues, type VaultField } from './types';
import { copySecret } from './clipboard';
import { generatePassword, generatePassphrase, DEFAULT_PW_OPTS, type PasswordOpts } from './generator';

const input = 'w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2.5 text-sm outline-none focus:border-emerald-500';
const label = 'block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1';

export function VaultItemSheet({ item, defaultType = 'login', onClose, onSaved }: { item?: VaultItemDTO | null; defaultType?: string; onClose: () => void; onSaved: () => void }) {
  const { encrypt, decrypt } = useVault();
  const toast = useToast();
  const isNew = !item;
  const [newType, setNewType] = useState(defaultType);
  const def = typeDef(item?.type || newType);
  const [values, setValues] = useState<FormValues>({ collection: '' });
  const [loaded, setLoaded] = useState(isNew);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  // In a NEW item you're typing the secret, so show it; an existing item is masked until revealed.
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!item) return;
    decrypt<Record<string, string>>(item.blob)
      .then((secret) => setValues(mergeForm(def, item, secret)))
      .catch(() => toast('error', 'Could not decrypt this item'))
      .finally(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  const set = (k: string, v: string) => setValues((p) => ({ ...p, [k]: v }));
  const isRevealed = (k: string) => isNew || !!revealed[k];

  async function save(close: () => void) {
    if (!(values.title || '').trim()) return toast('error', 'Give it a name');
    setBusy(true);
    try {
      const { metadata, secret } = splitForm(def, values);
      const blob = await encrypt(secret); // encrypt the secret fields client-side
      const body = { type: def.type, blob, ...metadata, collection: values.collection || null };
      if (item) await vaultApi.update(item.id, body);
      else await vaultApi.create(body as any);
      toast('success', item ? 'Saved' : 'Added to your vault');
      onSaved();
      close();
    } catch {
      toast('error', 'Could not save');
      setBusy(false);
    }
  }

  async function del(close: () => void) {
    if (!item) return;
    setBusy(true);
    try {
      await vaultApi.remove(item.id);
      toast('success', 'Deleted');
      onSaved();
      close();
    } catch {
      toast('error', 'Could not delete');
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={onClose} canClose={() => !busy}>
      {(close) => (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <def.icon size={18} className="text-emerald-600" />
            <h2 className="font-semibold">{isNew ? `New ${def.label.toLowerCase()}` : values.title || def.label}</h2>
          </div>

          {isNew && (
            <div className="flex gap-2 mb-4">
              {VAULT_TYPES.map((t) => (
                <button
                  key={t.type}
                  onClick={() => setNewType(t.type)}
                  className={`flex-1 rounded-lg border px-2 py-2 text-xs flex flex-col items-center gap-1 ${newType === t.type ? 'border-emerald-500 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400' : 'border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:border-zinc-300'}`}
                >
                  <t.icon size={16} />
                  {t.label}
                </button>
              ))}
            </div>
          )}

          {!loaded ? (
            <div className="flex justify-center py-10 text-zinc-400">
              <Loader2 className="animate-spin" size={18} />
            </div>
          ) : (
            <div className="space-y-3">
              {def.fields.map((f) => (
                <FieldRow key={f.key} f={f} value={values[f.key] || ''} onChange={(v) => set(f.key, v)} revealed={isRevealed(f.key)} onReveal={() => setRevealed((p) => ({ ...p, [f.key]: !p[f.key] }))} onCopy={async () => { await copySecret(values[f.key] || ''); toast('success', `${f.label} copied — clears in 30s`); }} onGenerate={f.generate ? (v) => { set(f.key, v); setRevealed((p) => ({ ...p, [f.key]: true })); } : undefined} />
              ))}

              <div>
                <label className={label}>Collection</label>
                <select className={input} value={values.collection || ''} onChange={(e) => set('collection', e.target.value)}>
                  <option value="">None</option>
                  {COLLECTIONS.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2 pt-2">
                <button onClick={() => save(close)} disabled={busy} className="flex-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2.5 text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-2">
                  {busy ? <Loader2 className="animate-spin" size={15} /> : <Check size={15} />}
                  {item ? 'Save' : 'Add'}
                </button>
                {item && !confirmDel && (
                  <button onClick={() => setConfirmDel(true)} disabled={busy} className="rounded-lg border border-red-300 dark:border-red-900 text-red-600 px-3 py-2.5 text-sm hover:bg-red-50 dark:hover:bg-red-950/40">
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
              {confirmDel && (
                <div className="rounded-lg border border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-3 text-sm">
                  <p className="mb-2 text-red-700 dark:text-red-300">Delete this item permanently? This can't be undone.</p>
                  <div className="flex gap-2">
                    <button onClick={() => del(close)} disabled={busy} className="rounded-lg bg-red-600 text-white px-3 py-1.5 text-sm hover:bg-red-500">Delete</button>
                    <button onClick={() => setConfirmDel(false)} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

function FieldRow({ f, value, onChange, revealed, onReveal, onCopy, onGenerate }: { f: VaultField; value: string; onChange: (v: string) => void; revealed: boolean; onReveal: () => void; onCopy: () => void; onGenerate?: (v: string) => void }) {
  const secret = !f.meta;
  const [genOpen, setGenOpen] = useState(false);
  if (f.kind === 'textarea') {
    return (
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className={label}>{f.label}</label>
          {secret && (
            <div className="flex gap-2">
              <button type="button" onClick={onReveal} className="text-zinc-400 hover:text-zinc-600">{revealed ? <EyeOff size={14} /> : <Eye size={14} />}</button>
              <button type="button" onClick={onCopy} className="text-zinc-400 hover:text-emerald-600"><Copy size={14} /></button>
            </div>
          )}
        </div>
        <textarea rows={3} value={value} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder} className={`${input} ${secret && !revealed ? 'blur-sm select-none' : ''}`} />
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className={label.replace(' mb-1', '')}>{f.label}</label>
        {onGenerate && (
          <button type="button" onClick={() => setGenOpen((o) => !o)} className="text-xs text-emerald-600 hover:text-emerald-500 flex items-center gap-1">
            <Wand2 size={13} /> Generate
          </button>
        )}
      </div>
      <div className="relative">
        <input
          type={secret && !revealed ? 'password' : f.kind === 'url' ? 'url' : 'text'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={f.placeholder}
          autoComplete="off"
          className={`${input} ${secret ? 'pr-16' : ''}`}
        />
        {secret && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-2">
            <button type="button" onClick={onReveal} className="text-zinc-400 hover:text-zinc-600">{revealed ? <EyeOff size={15} /> : <Eye size={15} />}</button>
            <button type="button" onClick={onCopy} className="text-zinc-400 hover:text-emerald-600"><Copy size={15} /></button>
          </div>
        )}
      </div>
      {onGenerate && genOpen && <GeneratorPopover onUse={(v) => { onGenerate(v); setGenOpen(false); }} />}
    </div>
  );
}

function GeneratorPopover({ onUse }: { onUse: (v: string) => void }) {
  const [mode, setMode] = useState<'password' | 'passphrase'>('password');
  const [opts, setOpts] = useState<PasswordOpts>(DEFAULT_PW_OPTS);
  const [words, setWords] = useState(4);
  const [preview, setPreview] = useState(() => generatePassword(DEFAULT_PW_OPTS));
  const regen = (m = mode, o = opts, w = words) => setPreview(m === 'password' ? generatePassword(o) : generatePassphrase(w));
  const toggle = (k: keyof PasswordOpts) => {
    const o = { ...opts, [k]: !opts[k] } as PasswordOpts;
    setOpts(o);
    regen('password', o);
  };
  return (
    <div className="mt-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-3">
      <div className="flex gap-1 mb-2">
        {(['password', 'passphrase'] as const).map((m) => (
          <button key={m} onClick={() => { setMode(m); regen(m); }} className={`px-2 py-1 rounded text-xs ${mode === m ? 'bg-emerald-600 text-white' : 'text-zinc-500'}`}>
            {m === 'password' ? 'Password' : 'Passphrase'}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 mb-2">
        <code className="flex-1 text-xs break-all rounded bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 px-2 py-1.5">{preview}</code>
        <button onClick={() => regen()} className="text-zinc-400 hover:text-emerald-600"><RefreshCw size={14} /></button>
      </div>
      {mode === 'password' ? (
        <div className="space-y-1.5 mb-2 text-xs text-zinc-500">
          <label className="flex items-center justify-between">
            Length: {opts.length}
            <input type="range" min={10} max={40} value={opts.length} onChange={(e) => { const o = { ...opts, length: Number(e.target.value) }; setOpts(o); regen('password', o); }} className="w-32 accent-emerald-600" />
          </label>
          <div className="flex gap-3">
            <label className="flex items-center gap-1"><input type="checkbox" checked={opts.uppercase} onChange={() => toggle('uppercase')} className="accent-emerald-600" /> A-Z</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={opts.numbers} onChange={() => toggle('numbers')} className="accent-emerald-600" /> 0-9</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={opts.symbols} onChange={() => toggle('symbols')} className="accent-emerald-600" /> !@#</label>
          </div>
        </div>
      ) : (
        <label className="flex items-center justify-between mb-2 text-xs text-zinc-500">
          Words: {words}
          <input type="range" min={3} max={7} value={words} onChange={(e) => { const w = Number(e.target.value); setWords(w); regen('passphrase', opts, w); }} className="w-32 accent-emerald-600" />
        </label>
      )}
      <button onClick={() => onUse(preview)} className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-xs font-medium">Use this</button>
    </div>
  );
}
