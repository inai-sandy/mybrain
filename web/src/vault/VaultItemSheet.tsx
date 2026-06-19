import { useEffect, useState } from 'react';
import { Eye, EyeOff, Copy, Trash2, Loader2, Check, Wand2, RefreshCw, Lock, ShieldAlert } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';
import { useVault } from './VaultContext';
import { vaultApi, type VaultItemDTO } from './client';
import { Paperclip, Download } from 'lucide-react';
import { typeDef, splitForm, mergeForm, COLLECTIONS, VAULT_TYPES, type FormValues, type VaultField } from './types';
import { copySecret } from './clipboard';
import { generatePassword, generatePassphrase, DEFAULT_PW_OPTS, type PasswordOpts } from './generator';
import { encryptFile, decryptFile, humanSize, type DocMeta } from './documents';

const input = 'w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2.5 text-sm outline-none focus:border-emerald-500';
const label = 'block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1';

export function VaultItemSheet({ item, defaultType = 'login', onClose, onSaved }: { item?: VaultItemDTO | null; defaultType?: string; onClose: () => void; onSaved: () => void }) {
  const { encrypt, decrypt, verifyPassphrase } = useVault();
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
  // Extra-sensitive fields (seed phrase / private key) require re-entering the passphrase before reveal/copy.
  const [reauthed, setReauthed] = useState<Set<string>>(new Set());
  const [reauthField, setReauthField] = useState<string | null>(null);
  // Secure documents: the decrypted file metadata (existing) + a newly-picked file.
  const [docMeta, setDocMeta] = useState<DocMeta | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!item) return;
    decrypt<Record<string, string>>(item.blob)
      .then((secret) => {
        setValues(mergeForm(def, item, secret));
        if (def.file) setDocMeta(secret as unknown as DocMeta);
      })
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
      if (def.file) {
        // Secure document. New: encrypt the file in the browser, create the item, upload ciphertext.
        if (item) {
          await vaultApi.update(item.id, { ...metadata, collection: values.collection || null }); // metadata-only edit
        } else {
          if (!file) {
            setBusy(false);
            return toast('error', 'Choose a file to attach');
          }
          const { secret: docSecret, cipher } = await encryptFile(file);
          const blob = await encrypt(docSecret);
          const created = await vaultApi.create({ type: 'document', blob, ...metadata, collection: values.collection || null } as any);
          await vaultApi.uploadFile(created.id, cipher);
        }
      } else {
        const blob = await encrypt(secret); // encrypt the secret fields client-side
        const body = { type: def.type, blob, ...metadata, collection: values.collection || null };
        if (item) await vaultApi.update(item.id, body);
        else await vaultApi.create(body as any);
      }
      toast('success', item ? 'Saved' : 'Added to your vault');
      onSaved();
      close();
    } catch {
      toast('error', 'Could not save');
      setBusy(false);
    }
  }

  async function download() {
    if (!item || !docMeta) return;
    setDownloading(true);
    try {
      const bytes = new Uint8Array(await vaultApi.downloadFile(item.id));
      const blob = await decryptFile(docMeta, bytes); // decrypts in the browser
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = docMeta.filename || 'document';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      toast('error', 'Could not open the file');
    } finally {
      setDownloading(false);
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
              {def.fields.map((f) => {
                const gated = !!f.reauth && !isNew && !reauthed.has(f.key); // needs re-auth before showing/copying
                return (
                  <FieldRow
                    key={f.key}
                    f={f}
                    value={values[f.key] || ''}
                    onChange={(v) => set(f.key, v)}
                    revealed={isRevealed(f.key) && !gated}
                    locked={gated}
                    onReveal={() => {
                      if (gated) return setReauthField(f.key);
                      setRevealed((p) => ({ ...p, [f.key]: !p[f.key] }));
                    }}
                    onCopy={async () => {
                      if (gated) return setReauthField(f.key);
                      await copySecret(values[f.key] || '');
                      toast('success', `${f.label} copied — clears in 30s`);
                    }}
                    onGenerate={f.generate ? (v) => { set(f.key, v); setRevealed((p) => ({ ...p, [f.key]: true })); } : undefined}
                  />
                );
              })}

              {reauthField && (
                <ReauthPrompt
                  label={def.fields.find((f) => f.key === reauthField)?.label || 'this field'}
                  verify={verifyPassphrase}
                  onCancel={() => setReauthField(null)}
                  onOk={() => {
                    setReauthed((s) => new Set(s).add(reauthField));
                    setRevealed((p) => ({ ...p, [reauthField]: true }));
                    setReauthField(null);
                  }}
                />
              )}

              {def.file && (
                <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
                  {item && docMeta ? (
                    <div className="flex items-center gap-3">
                      <Paperclip size={16} className="text-zinc-400 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{docMeta.filename}</div>
                        <div className="text-xs text-zinc-500">{humanSize(docMeta.size)} · encrypted</div>
                      </div>
                      <button onClick={download} disabled={downloading} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1.5 disabled:opacity-50">
                        {downloading ? <Loader2 className="animate-spin" size={14} /> : <Download size={14} />} Open
                      </button>
                    </div>
                  ) : (
                    <label className="block cursor-pointer text-center py-4 text-sm text-zinc-500 hover:text-emerald-600">
                      <input type="file" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
                      <Paperclip size={18} className="mx-auto mb-1" />
                      {file ? `${file.name} · ${humanSize(file.size)}` : 'Choose a file to encrypt & attach'}
                      <div className="text-[11px] text-zinc-400 mt-1">Encrypted in your browser · max 25 MB</div>
                    </label>
                  )}
                </div>
              )}

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

function FieldRow({ f, value, onChange, revealed, locked, onReveal, onCopy, onGenerate }: { f: VaultField; value: string; onChange: (v: string) => void; revealed: boolean; locked?: boolean; onReveal: () => void; onCopy: () => void; onGenerate?: (v: string) => void }) {
  const secret = !f.meta;
  const [genOpen, setGenOpen] = useState(false);
  const RevealIcon = locked ? Lock : revealed ? EyeOff : Eye;
  if (f.kind === 'textarea') {
    return (
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className={label}>{f.label}</label>
          {secret && (
            <div className="flex gap-2 items-center">
              {f.reauth && <span className="text-[10px] text-amber-500 flex items-center gap-0.5"><ShieldAlert size={11} /> re-auth</span>}
              <button type="button" onClick={onReveal} className={`hover:text-zinc-600 ${locked ? 'text-amber-500' : 'text-zinc-400'}`}><RevealIcon size={14} /></button>
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
            <button type="button" onClick={onReveal} className={`hover:text-zinc-600 ${locked ? 'text-amber-500' : 'text-zinc-400'}`}><RevealIcon size={15} /></button>
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

// Re-enter the master passphrase to reveal an extra-sensitive field (seed phrase / private key).
function ReauthPrompt({ label, verify, onOk, onCancel }: { label: string; verify: (p: string) => Promise<boolean>; onOk: () => void; onCancel: () => void }) {
  const toast = useToast();
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    if (!pass) return;
    setBusy(true);
    const ok = await verify(pass);
    if (ok) {
      onOk();
    } else {
      toast('error', 'Wrong passphrase');
      setBusy(false);
    }
  }
  return (
    <div className="rounded-lg border border-amber-400/50 bg-amber-50 dark:bg-amber-950/30 p-3">
      <p className="text-sm text-amber-800 dark:text-amber-200 mb-2 flex items-center gap-1.5">
        <ShieldAlert size={15} /> Re-enter your passphrase to reveal <b>{label}</b>.
      </p>
      <input type="password" value={pass} autoFocus onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} placeholder="master passphrase" className="w-full rounded-lg bg-white dark:bg-zinc-950 border border-amber-300 dark:border-amber-800 px-3 py-2 text-sm outline-none focus:border-amber-500 mb-2" />
      <div className="flex gap-2">
        <button onClick={go} disabled={busy || !pass} className="rounded-lg bg-amber-600 hover:bg-amber-500 text-white px-3 py-1.5 text-sm disabled:opacity-40 flex items-center gap-1.5">
          {busy ? <Loader2 className="animate-spin" size={14} /> : <Check size={14} />} Reveal
        </button>
        <button onClick={onCancel} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Cancel</button>
      </div>
    </div>
  );
}
