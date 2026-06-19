# My Brain — Vault (zero-knowledge secrets) — what we're building (and why)

A **zero-knowledge, end-to-end encrypted vault** inside My Brain for the owner's most sensitive data — passwords, API secrets, payment cards, bank accounts, crypto wallets, identity documents and more. The defining guarantee: **the server can never read the vault.** Secrets are encrypted and decrypted **on the owner's device**; the server only ever stores ciphertext.

## Why
My Brain already holds the owner's whole working life. Vaults add the things that must NEVER leak — and must never be readable by the server, by Claude, or by any AI. This is the one area where convenience yields to security. (Locked decision, ties to [[project_mybrain_explore]] and [[feedback_no_blind_delete]].)

## Security model (the foundation — decided)
- **Zero-knowledge / E2E.** A **Vault Master Passphrase** (separate from the app login) is run through **Argon2id** (memory-hard, in the browser) to derive the master key. Secrets are encrypted/decrypted client-side with **AES-256-GCM**. The server stores only ciphertext + a verifier; it never sees the passphrase or plaintext. Even a fully compromised server yields gibberish.
- **Envelope encryption.** Each item gets a random data key; data keys are wrapped by the vault key; the vault key is wrapped by the master key (and by the recovery key). Changing the passphrase re-wraps the vault key only — no re-encrypting every item.
- **Recovery = one Recovery Key.** A high-entropy code generated at setup that independently unwraps the vault key. **Setup will not complete until the owner confirms they've saved it.** Lose both passphrase and recovery key → the vault is unrecoverable, by design (no server reset).
- **Unlock.** Biometric/passkey (WebAuthn — Face ID / fingerprint) for one-tap daily unlock, with the master passphrase as the root. **Auto-lock** after 5 min idle, on logout, or on tab close. The unlocked key lives only in memory (non-extractable Web Crypto key); never localStorage, never logged.
- **Never indexed.** Secret values never go to OpenAI / RAG / SuperMemory. Only **searchable metadata** is searchable, and only **locally**.

## Searchable boundary (decided)
- **Searchable (local keyword only, never sent anywhere):** title · website/URL · username · tags · card *type* · bank *name*.
- **Never searchable / always encrypted + masked:** passwords, full card numbers, CVV, PINs, seed phrases, private keys, account numbers, identity numbers, document contents.

## Sections (item types) — each with a tailored field schema
1. **Logins** — username · password · URL · 2FA/TOTP secret · notes
2. **API secrets / keys** — service · key · secret · environment · expiry
3. **Payment cards** — cardholder · number · expiry · CVV · PIN · billing
4. **Bank accounts** — bank · account no · IFSC/IBAN/routing · holder · type
5. **Crypto wallets** — wallet · address · seed phrase · private key · network
6. **Identity / personal** — name · DOB · passport · license · Aadhaar/PAN · address
7. **Secure documents** — encrypted file attachments
8. **Secure notes** — free-form encrypted text
9. **Software licenses** — product · key · registered email
10. **Wi-Fi / network** — SSID · password · security type
11. **Memberships / loyalty** — provider · number · PIN

Plus: **Collections** (Personal · Work · Beakn · Family) · **tags** · **favorites/pinned**.

## Security features
Masked-by-default with **click-to-reveal** (re-auth for high-sensitivity: seeds, private keys) · **copy auto-clears clipboard** (~30s) · strong **password/passphrase generator** · **reused/weak password detection** (local) · per-item **audit trail** (when revealed/edited — never the value) · optional privacy-safe **breach check** (k-anonymity) · encrypted blobs flow into the existing nightly backups ([[project_backups]]) safely.

## Build order (one project, crypto-core-first)
1. **Vault core** — the client-side zero-knowledge crypto engine (Argon2id, envelope encryption, AES-256-GCM), master-passphrase setup + forced Recovery Key, verifier, auto-lock, encrypted-blob storage API. Hardened + tested before any real secret goes in.
2. **First types + reveal/copy/generator** — Logins, Secure notes, Payment cards (the everyday set) on the core.
3. **High-stakes types** — Bank accounts, Crypto wallets, Identity, API secrets.
4. **Remaining + import** — Documents, licenses, Wi-Fi, memberships; biometric/passkey unlock; import from 1Password / Bitwarden / CSV; local label-only search; audit view.

## Standards (always)
Responsive · dark mode · accessible · confirm-before-delete · friendly errors · list standards on the vault list (search/filter/sort/pagination/count over *metadata only*). Auto-logout on inactivity. Secrets never in logs, never in the index, never to any AI.

## Out of scope (for now)
Secure sharing with others · organisation/team vaults · server-side decryption of any kind · indexing secret values (ever).
