import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Eye, EyeOff, Copy, Trash2, Loader2, Check, Wand2, RefreshCw, Lock, ShieldAlert, ChevronLeft, ChevronRight } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';
import { useVault } from './VaultContext';
import { vaultApi, type VaultItemDTO } from './client';
import { Paperclip, Download, History } from 'lucide-react';
import { typeDef, splitForm, mergeForm, sectionedFields, COLLECTIONS, VAULT_GROUPS, type FormValues, type VaultField, type VaultType } from './types';
import { copySecret } from './clipboard';
import { generatePassword, generatePassphrase, isWeakPassword, DEFAULT_PW_OPTS, type PasswordOpts } from './generator';
import { encryptFile, decryptFile, humanSize, type DocMeta } from './documents';

const input = 'w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2.5 text-sm outline-none focus:border-emerald-500 transition-colors';
const label = 'block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1';

// Lightweight local password strength (never leaves the browser) for generate-capable fields.
function pwStrength(s: string): { pct: number; label: string; cls: string } {
  if (!s) return { pct: 0, label: '', cls: 'bg-zinc-300' };
  let n = 0;
  if (s.length >= 8) n++;
  if (s.length >= 14) n++;
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) n++;
  if (/\d/.test(s)) n++;
  if (/[^A-Za-z0-9]/.test(s)) n++;
  if (s.length >= 20) n++;
  const score = Math.min(4, Math.max(0, n - 1));
  return {
    pct: ((score + 1) / 5) * 100,
    label: ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'][score],
    cls: ['bg-red-500', 'bg-red-500', 'bg-amber-500', 'bg-emerald-500', 'bg-emerald-600'][score],
  };
}

export function VaultItemSheet({ item, defaultType = 'login', onClose, onSaved }: { item?: VaultItemDTO | null; defaultType?: string; onClose: () => void; onSaved: () => void }) {
  const { encrypt, decrypt, verifyPassphrase } = useVault();
  const toast = useToast();
  const reduce = useReducedMotion();
  const isNew = !item;
  // New items begin on the type chooser; editing opens straight to the form.
  const [stage, setStage] = useState<'pick' | 'form'>(isNew ? 'pick' : 'form');
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
  const [history, setHistory] = useState<{ action: string; at: string }[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const logAudit = (action: string) => {
    if (item) vaultApi.addAudit(item.id, action);
  };

  useEffect(() => {
    if (!item) return;
    decrypt<Record<string, string>>(item.blob)
      .then((secret) => {
        setValues(mergeForm(def, item, secret));
        if (def.file) setDocMeta(secret as unknown as DocMeta);
      })
      .catch(() => toast('error', 'Could not decrypt this item'))
      .finally(() => setLoaded(true));
    vaultApi.listAudit(item.id).then(setHistory).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  const set = (k: string, v: string) => setValues((p) => ({ ...p, [k]: v }));
  const isRevealed = (k: string) => isNew || !!revealed[k];

  function pickType(type: string) {
    setNewType(type);
    setValues({ collection: '' });
    setRevealed({});
    setStage('form');
  }

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
      if (item) logAudit('edited');
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

  const slide = (dir: number) =>
    reduce ? {} : { initial: { opacity: 0, x: dir * 24 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: dir * -24 }, transition: { duration: 0.18 } };

  return (
    <Sheet onClose={onClose} canClose={() => !busy}>
      {(close) => (
        <div className="overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            {stage === 'pick' ? (
              <motion.div key="pick" {...slide(1)}>
                <TypeChooser onPick={pickType} />
              </motion.div>
            ) : (
              <motion.div key="form" {...slide(1)}>
                {/* Header */}
                <div className="flex items-center gap-2.5 mb-4">
                  {isNew && (
                    <button onClick={() => setStage('pick')} className="-ml-1 p-1 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="Back to types">
                      <ChevronLeft size={18} />
                    </button>
                  )}
                  <div className="grid place-items-center h-9 w-9 shrink-0 rounded-xl bg-emerald-600/10 text-emerald-600">
                    <def.icon size={18} />
                  </div>
                  <div className="min-w-0">
                    <h2 className="font-semibold leading-tight truncate">{isNew ? `New ${def.label.toLowerCase()}` : values.title || def.label}</h2>
                    {!isNew && <p className="text-xs text-zinc-500 truncate">{def.label}</p>}
                  </div>
                </div>

                {!loaded ? (
                  <div className="flex justify-center py-10 text-zinc-400">
                    <Loader2 className="animate-spin" size={18} />
                  </div>
                ) : (
                  <div className="space-y-4">
                    {sectionedFields(def).map((group, gi) => (
                      <div key={gi} className={group.section ? 'rounded-xl border border-zinc-200 dark:border-zinc-800 p-3 space-y-3' : 'space-y-3'}>
                        {group.section && <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{group.section}</div>}
                        {group.fields.map((f) => {
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
                                setRevealed((p) => {
                                  if (!p[f.key]) logAudit('revealed');
                                  return { ...p, [f.key]: !p[f.key] };
                                });
                              }}
                              onCopy={async () => {
                                if (gated) return setReauthField(f.key);
                                await copySecret(values[f.key] || '');
                                logAudit('copied');
                                toast('success', `${f.label} copied — clears in 30s`);
                              }}
                              onGenerate={f.generate ? (v) => { set(f.key, v); setRevealed((p) => ({ ...p, [f.key]: true })); } : undefined}
                            />
                          );
                        })}
                      </div>
                    ))}

                    {reauthField && (
                      <ReauthPrompt
                        label={def.fields.find((f) => f.key === reauthField)?.label || 'this field'}
                        verify={verifyPassphrase}
                        onCancel={() => setReauthField(null)}
                        onOk={() => {
                          setReauthed((s) => new Set(s).add(reauthField));
                          setRevealed((p) => ({ ...p, [reauthField]: true }));
                          logAudit('revealed');
                          setReauthField(null);
                        }}
                      />
                    )}

                    {def.file && (
                      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-3">
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

                    <div className="flex items-center gap-2 pt-1">
                      <button onClick={() => save(close)} disabled={busy} className="flex-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2.5 text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-2 transition-colors">
                        {busy ? <Loader2 className="animate-spin" size={15} /> : <Check size={15} />}
                        {item ? 'Save' : 'Add to vault'}
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

                    {item && history.length > 0 && (
                      <div className="pt-1">
                        <button onClick={() => setShowHistory((s) => !s)} className="text-xs text-zinc-400 hover:text-zinc-600 flex items-center gap-1">
                          <History size={12} /> History ({history.length})
                        </button>
                        {showHistory && (
                          <ul className="mt-2 space-y-1 max-h-32 overflow-y-auto">
                            {history.map((h, i) => (
                              <li key={i} className="text-xs text-zinc-500 flex justify-between">
                                <span className="capitalize">{h.action}</span>
                                <span>{new Date(h.at).toLocaleString()}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </Sheet>
  );
}

// ---- Step 1: grouped type chooser ----
function TypeChooser({ onPick }: { onPick: (type: string) => void }) {
  return (
    <div>
      <h2 className="font-semibold mb-1">Add to your vault</h2>
      <p className="text-sm text-zinc-500 mb-4">What would you like to store?</p>
      <div className="space-y-4">
        {VAULT_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 mb-1.5">{group.label}</div>
            <div className="grid grid-cols-2 gap-2">
              {group.types.map((t) => (
                <TypeButton key={t.type} t={t} onClick={() => onPick(t.type)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TypeButton({ t, onClick }: { t: VaultType; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group flex items-center gap-3 text-left rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 hover:border-emerald-400 dark:hover:border-emerald-700 hover:bg-emerald-50/40 dark:hover:bg-emerald-950/20 transition-colors active:scale-[0.98]"
    >
      <div className="grid place-items-center h-9 w-9 shrink-0 rounded-lg bg-emerald-600/10 text-emerald-600">
        <t.icon size={17} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{t.label}</div>
        {t.hint && <div className="text-[11px] text-zinc-500 truncate">{t.hint}</div>}
      </div>
      <ChevronRight size={15} className="text-zinc-300 dark:text-zinc-600 group-hover:text-emerald-500 shrink-0" />
    </button>
  );
}

function FieldRow({ f, value, onChange, revealed, locked, onReveal, onCopy, onGenerate }: { f: VaultField; value: string; onChange: (v: string) => void; revealed: boolean; locked?: boolean; onReveal: () => void; onCopy: () => void; onGenerate?: (v: string) => void }) {
  const secret = !f.meta;
  const [genOpen, setGenOpen] = useState(false);
  const RevealIcon = locked ? Lock : revealed ? EyeOff : Eye;
  // Strength meter under generate-capable password fields when there's a value and it's visible.
  const strength = useMemo(() => (f.generate && value ? pwStrength(value) : null), [f.generate, value]);
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
      {strength && (
        <div className="mt-1.5 flex items-center gap-2">
          <div className="h-1 flex-1 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
            <div className={`h-full ${strength.cls} transition-all`} style={{ width: `${strength.pct}%` }} />
          </div>
          <span className="text-[10px] text-zinc-400 w-14 text-right">{isWeakPassword(value) ? 'Weak' : strength.label}</span>
        </div>
      )}
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
