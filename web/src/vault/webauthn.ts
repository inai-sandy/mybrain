// Biometric / passkey vault unlock via WebAuthn's PRF extension.
//
// The authenticator (Face ID / fingerprint) yields a per-credential 32-byte secret (the PRF output)
// after a successful biometric check. We wrap the vault key with that secret and store only the
// ciphertext on the server. The biometric never leaves the device; the server stays zero-knowledge.
import { randomBytes, b64encode, b64decode, importAesKey, aesEncrypt, aesDecrypt, type Cipher } from './crypto';

const RP_NAME = 'My Brain Vault';
// A constant PRF input. Each credential still produces a UNIQUE secret (PRF is keyed per credential).
const PRF_SALT = new TextEncoder().encode('mybrain-vault-prf-v1');

const ab = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

function b64url(bytes: Uint8Array): string {
  return b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Uint8Array {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  return b64decode(p + '==='.slice((p.length + 3) % 4));
}

export function biometricSupported(): boolean {
  return typeof window !== 'undefined' && !!(window as any).PublicKeyCredential && !!navigator.credentials?.create;
}

/**
 * True only when a real PLATFORM authenticator (Touch ID / Face ID / Windows Hello) is present.
 * This must gate the biometric UI: if we offer biometrics where only a security key is eligible,
 * Safari on macOS builds an `ASAuthorizationSecurityKeyPublicKeyCredential…Request` and calling the
 * PRF extension on it crashes the whole web app (SIGABRT) — a native abort no try/catch can catch.
 */
export async function platformBiometricAvailable(): Promise<boolean> {
  if (!biometricSupported()) return false;
  try {
    const PKC: any = (window as any).PublicKeyCredential;
    return !!(await PKC.isUserVerifyingPlatformAuthenticatorAvailable?.());
  } catch {
    return false;
  }
}

// ---- pure, testable wrap/unwrap (the security boundary; WebAuthn ceremony is separate) ----
export async function wrapForDevice(prfSecret: Uint8Array, vaultKeyRaw: Uint8Array): Promise<Cipher> {
  return aesEncrypt(await importAesKey(prfSecret), vaultKeyRaw);
}
export async function unwrapForDevice(prfSecret: Uint8Array, wrap: Cipher): Promise<Uint8Array> {
  return aesDecrypt(await importAesKey(prfSecret), wrap);
}

export type DeviceEnrollment = { credentialId: string; label: string; wrap: Cipher };

async function prfFromCreate(cred: PublicKeyCredential): Promise<Uint8Array | null> {
  const r: any = cred.getClientExtensionResults?.();
  const first = r?.prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}

/** Run a get() ceremony and return the PRF secret for the used credential + which credential id it was. */
async function assertPrf(allowIds: Uint8Array[]): Promise<{ secret: Uint8Array; usedId: string }> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: ab(randomBytes(32)),
      // `transports: ['internal']` steers the request to the PLATFORM authenticator (Touch ID / Face ID)
      // rather than a security key, so Safari uses the credential class that supports the PRF extension.
      allowCredentials: allowIds.map((id) => ({ type: 'public-key', id: ab(id), transports: ['internal'] as AuthenticatorTransport[] })),
      userVerification: 'required',
      timeout: 60000,
      extensions: { prf: { eval: { first: ab(PRF_SALT) } } } as any,
    },
  })) as PublicKeyCredential;
  const ext: any = assertion.getClientExtensionResults();
  const first = ext?.prf?.results?.first;
  if (!first) throw new Error('This device does not support biometric vault unlock (no PRF).');
  return { secret: new Uint8Array(first), usedId: b64url(new Uint8Array(assertion.rawId)) };
}

/** Enroll this device. Needs the raw vault key (caller re-auths with the passphrase first). */
export async function enrollDevice(label: string, vaultKeyRaw: Uint8Array): Promise<DeviceEnrollment> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: ab(randomBytes(32)),
      rp: { name: RP_NAME, id: location.hostname },
      user: { id: ab(randomBytes(16)), name: 'vault', displayName: 'My Brain Vault' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      // Pin the PLATFORM authenticator (Touch ID / Face ID / Windows Hello). Without this, Safari on
      // macOS treats a security key as eligible and builds an ASAuthorizationSecurityKey…Request, which
      // has no PRF support — calling setPrf: on it crashes the whole web app (SIGABRT). Forcing 'platform'
      // routes to the class that supports PRF.
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000,
      extensions: { prf: { eval: { first: ab(PRF_SALT) } } } as any,
    },
  })) as PublicKeyCredential;
  if (!cred) throw new Error('Enrollment was cancelled');
  const credId = new Uint8Array(cred.rawId);
  // Prefer the PRF result from create(); fall back to a get() if the platform only returns it there.
  const secret = (await prfFromCreate(cred)) || (await assertPrf([credId])).secret;
  return { credentialId: b64url(credId), label, wrap: await wrapForDevice(secret, vaultKeyRaw) };
}

/** Unlock with a registered device. Returns the raw vault key bytes. */
export async function unlockWithDevice(devices: { credentialId: string; wrap: Cipher }[]): Promise<Uint8Array> {
  if (!devices.length) throw new Error('No biometric devices enrolled');
  const { secret, usedId } = await assertPrf(devices.map((d) => fromB64url(d.credentialId)));
  const device = devices.find((d) => d.credentialId === usedId);
  if (!device) throw new Error('That device is not registered');
  return unwrapForDevice(secret, device.wrap);
}
