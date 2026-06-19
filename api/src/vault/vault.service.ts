import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { promises as fs } from 'fs';
import { join } from 'path';

// Where encrypted document blobs live on the data volume (ciphertext only — same volume as the DB).
const FILE_DIR = join(process.env.DATA_DIR || '/app/data', 'vault-files');

// A wrapped/encrypted blob as produced on the client. The server treats these as opaque ciphertext.
type Cipher = { iv: string; ct: string };

export type VaultMetaInput = {
  kdfParams: unknown;
  salt: string;
  verifier: Cipher;
  wrapPass: Cipher;
  wrapRecovery: Cipher;
};

// Only these columns are ever stored in plaintext — searchable METADATA, never a secret value.
const META_COLUMNS = ['title', 'website', 'username', 'tags', 'cardType', 'bankName', 'collection'] as const;
const SEARCH_COLUMNS = ['title', 'website', 'username', 'tags', 'cardType', 'bankName'] as const;
const ITEM_TYPES = ['login', 'apisecret', 'card', 'bank', 'crypto', 'identity', 'document', 'note', 'license', 'wifi', 'membership'];

export type VaultItemInput = {
  type: string;
  blob: unknown; // opaque EncryptedBlob — must be present, must not be empty
  title?: string | null;
  website?: string | null;
  username?: string | null;
  tags?: string | null;
  cardType?: string | null;
  bankName?: string | null;
  collection?: string | null;
  favorite?: boolean;
};

@Injectable()
export class VaultService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- meta (the crypto envelope) ----
  async getMeta() {
    const m = await this.prisma.vaultMeta.findFirst();
    if (!m) return { setup: false };
    // Hand back everything the client needs to unlock — all of it is ciphertext / public KDF params.
    return {
      setup: true,
      kdfParams: JSON.parse(m.kdfParams),
      salt: m.salt,
      verifier: JSON.parse(m.verifier),
      wrapPass: JSON.parse(m.wrapPass),
      wrapRecovery: JSON.parse(m.wrapRecovery),
      createdAt: m.createdAt,
    };
  }

  /** First-run setup. The vault can be set up exactly once. */
  async createMeta(input: VaultMetaInput) {
    if (await this.prisma.vaultMeta.findFirst()) throw new BadRequestException('Vault is already set up');
    this.requireCipher(input.verifier, 'verifier');
    this.requireCipher(input.wrapPass, 'wrapPass');
    this.requireCipher(input.wrapRecovery, 'wrapRecovery');
    if (!input.salt || typeof input.salt !== 'string') throw new BadRequestException('salt required');
    const m = await this.prisma.vaultMeta.create({
      data: {
        kdfParams: JSON.stringify(input.kdfParams || {}),
        salt: input.salt,
        verifier: JSON.stringify(input.verifier),
        wrapPass: JSON.stringify(input.wrapPass),
        wrapRecovery: JSON.stringify(input.wrapRecovery),
      },
    });
    return { setup: true, createdAt: m.createdAt };
  }

  /** Re-wrap the vault key (passphrase change / new recovery key). Items are untouched. */
  async rewrapMeta(input: { salt?: string; kdfParams?: unknown; verifier?: Cipher; wrapPass: Cipher; wrapRecovery?: Cipher }) {
    const m = await this.prisma.vaultMeta.findFirst();
    if (!m) throw new NotFoundException('Vault is not set up');
    this.requireCipher(input.wrapPass, 'wrapPass');
    if (input.wrapRecovery) this.requireCipher(input.wrapRecovery, 'wrapRecovery');
    await this.prisma.vaultMeta.update({
      where: { id: m.id },
      data: {
        ...(input.salt ? { salt: input.salt } : {}),
        ...(input.kdfParams ? { kdfParams: JSON.stringify(input.kdfParams) } : {}),
        ...(input.verifier ? { verifier: JSON.stringify(input.verifier) } : {}),
        wrapPass: JSON.stringify(input.wrapPass),
        ...(input.wrapRecovery ? { wrapRecovery: JSON.stringify(input.wrapRecovery) } : {}),
      },
    });
    return { ok: true };
  }

  // ---- items (ciphertext only) ----
  async listItems(q: { search?: string; type?: string; collection?: string; favorite?: boolean; sort?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 25));
    const where: any = {};
    if (q.type) where.type = q.type;
    if (q.collection) where.collection = q.collection;
    if (typeof q.favorite === 'boolean') where.favorite = q.favorite;
    if (q.search?.trim()) {
      const s = q.search.trim();
      // Metadata-only search — NEVER touches the encrypted blob.
      where.OR = SEARCH_COLUMNS.map((c) => ({ [c]: { contains: s } }));
    }
    const orderBy =
      q.sort === 'oldest' ? { createdAt: 'asc' as const } : q.sort === 'title' ? { title: 'asc' as const } : { createdAt: 'desc' as const };
    const [rows, total] = await Promise.all([
      this.prisma.vaultItem.findMany({ where, orderBy, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.vaultItem.count({ where }),
    ]);
    return { items: rows.map((r) => this.shape(r)), total, page, pageSize };
  }

  async getItem(id: string) {
    const r = await this.prisma.vaultItem.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Item not found');
    return this.shape(r);
  }

  async createItem(input: VaultItemInput) {
    const row = await this.prisma.vaultItem.create({ data: this.toData(input, true) });
    await this.prisma.vaultAudit.create({ data: { itemId: row.id, action: 'created' } }).catch(() => undefined);
    return this.shape(row);
  }

  async updateItem(id: string, input: Partial<VaultItemInput>) {
    if (!(await this.prisma.vaultItem.findUnique({ where: { id } }))) throw new NotFoundException('Item not found');
    return this.shape(await this.prisma.vaultItem.update({ where: { id }, data: this.toData(input, false) }));
  }

  /** Delete ONE item by id (no bulk/"delete all" — honors no-blind-delete). Also removes any encrypted file. */
  async deleteItem(id: string) {
    if (!(await this.prisma.vaultItem.findUnique({ where: { id } }))) throw new NotFoundException('Item not found');
    await this.prisma.vaultItem.delete({ where: { id } });
    await this.prisma.vaultAudit.deleteMany({ where: { itemId: id } }).catch(() => undefined);
    await fs.unlink(this.filePath(id)).catch(() => undefined);
    return { ok: true };
  }

  // ---- encrypted document attachments (ciphertext at rest) ----
  private filePath(id: string) {
    return join(FILE_DIR, id.replace(/[^a-zA-Z0-9-]/g, '')); // id is a uuid; sanitize defensively
  }

  /** Store the already-encrypted file bytes for a document item. The bytes are opaque ciphertext. */
  async saveFile(id: string, bytes: Buffer) {
    const item = await this.prisma.vaultItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Item not found');
    if (item.type !== 'document') throw new BadRequestException('Only document items can hold a file');
    if (!bytes?.length) throw new BadRequestException('Empty file');
    await fs.mkdir(FILE_DIR, { recursive: true });
    await fs.writeFile(this.filePath(id), bytes);
    return { ok: true };
  }

  /** Read back the encrypted file bytes (still ciphertext — decryption happens in the browser). */
  async readFile(id: string): Promise<Buffer> {
    const item = await this.prisma.vaultItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Item not found');
    try {
      return await fs.readFile(this.filePath(id));
    } catch {
      throw new NotFoundException('No file attached');
    }
  }

  async count() {
    return { count: await this.prisma.vaultItem.count() };
  }

  // ---- biometric / passkey devices (WebAuthn PRF) ----
  async listDevices() {
    const rows = await this.prisma.vaultDevice.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((d) => ({ id: d.id, credentialId: d.credentialId, label: d.label, wrap: JSON.parse(d.wrap), createdAt: d.createdAt }));
  }

  async addDevice(input: { credentialId: string; label: string; wrap: Cipher }) {
    if (!input?.credentialId || typeof input.credentialId !== 'string') throw new BadRequestException('credentialId required');
    this.requireCipher(input.wrap, 'wrap');
    const wrap = JSON.stringify(input.wrap);
    const label = (input.label || 'This device').slice(0, 80);
    await this.prisma.vaultDevice.upsert({
      where: { credentialId: input.credentialId },
      create: { credentialId: input.credentialId, label, wrap },
      update: { label, wrap },
    });
    return { ok: true };
  }

  /** Revoke ONE device by id (no bulk). */
  async removeDevice(id: string) {
    if (!(await this.prisma.vaultDevice.findUnique({ where: { id } }))) throw new NotFoundException('Device not found');
    await this.prisma.vaultDevice.delete({ where: { id } });
    return { ok: true };
  }

  // ---- per-item audit trail (timestamps + action only — never a value) ----
  private static AUDIT_ACTIONS = ['created', 'edited', 'revealed', 'copied'];
  async addAudit(itemId: string, action: string) {
    if (!VaultService.AUDIT_ACTIONS.includes(action)) throw new BadRequestException('invalid action');
    await this.prisma.vaultAudit.create({ data: { itemId, action } });
    // keep only the last 50 events per item
    const old = await this.prisma.vaultAudit.findMany({ where: { itemId }, orderBy: { at: 'desc' }, skip: 50, select: { id: true } });
    if (old.length) await this.prisma.vaultAudit.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    return { ok: true };
  }

  async listAudit(itemId: string) {
    return this.prisma.vaultAudit.findMany({ where: { itemId }, orderBy: { at: 'desc' }, take: 50 });
  }

  /** Toggle favorite/pinned. */
  async setFavorite(id: string, favorite: boolean) {
    if (!(await this.prisma.vaultItem.findUnique({ where: { id } }))) throw new NotFoundException('Item not found');
    return this.shape(await this.prisma.vaultItem.update({ where: { id }, data: { favorite } }));
  }

  // ---- helpers ----
  private requireCipher(c: any, name: string) {
    if (!c || typeof c.iv !== 'string' || typeof c.ct !== 'string') throw new BadRequestException(`${name} must be {iv,ct}`);
  }

  private toData(input: Partial<VaultItemInput>, isCreate: boolean) {
    const data: any = {};
    if (isCreate || input.type !== undefined) {
      if (!input.type || !ITEM_TYPES.includes(input.type)) throw new BadRequestException('invalid item type');
      data.type = input.type;
    }
    if (isCreate || input.blob !== undefined) {
      const blob = input.blob;
      // The blob must be the opaque client ciphertext envelope — reject anything that isn't.
      if (!blob || typeof blob !== 'object' || (blob as any).v !== 1 || !(blob as any).item?.ct || !(blob as any).dataKey?.ct) {
        throw new BadRequestException('blob must be an EncryptedBlob produced on the client');
      }
      data.blob = JSON.stringify(blob);
    }
    for (const c of META_COLUMNS) {
      if (input[c] !== undefined) data[c] = input[c] === '' ? null : (input[c] as any);
    }
    if (input.favorite !== undefined) data.favorite = !!input.favorite;
    return data;
  }

  private shape(r: any) {
    return {
      id: r.id,
      type: r.type,
      blob: JSON.parse(r.blob),
      title: r.title,
      website: r.website,
      username: r.username,
      tags: r.tags,
      cardType: r.cardType,
      bankName: r.bankName,
      collection: r.collection,
      favorite: r.favorite,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}
