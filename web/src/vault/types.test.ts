import { describe, expect, it } from 'vitest';
import { typeDef, splitForm, mergeForm } from './types';
import type { VaultItemDTO } from './client';

describe('login field mapping (metadata vs secret boundary)', () => {
  const def = typeDef('login');

  it('routes searchable fields to metadata and secrets to the encrypted payload', () => {
    const { metadata, secret } = splitForm(def, {
      title: 'Gmail',
      website: 'mail.google.com',
      username: 'sandy',
      password: 's3cr3t',
      totp: 'JBSW',
      notes: 'main account',
      tags: 'email, google',
      collection: 'Personal',
    });
    // Searchable metadata — plaintext columns
    expect(metadata).toMatchObject({ title: 'Gmail', website: 'mail.google.com', username: 'sandy', tags: 'email, google' });
    // The password / TOTP / notes must NEVER appear as metadata
    expect(Object.values(metadata)).not.toContain('s3cr3t');
    expect(Object.values(metadata)).not.toContain('JBSW');
    expect(Object.values(metadata)).not.toContain('main account');
    // …they live in the secret payload (which gets encrypted)
    expect(secret).toEqual({ password: 's3cr3t', totp: 'JBSW', notes: 'main account' });
  });

  it('empty fields become null metadata / are omitted from the secret', () => {
    const { metadata, secret } = splitForm(def, { title: 'X', website: '', password: '' });
    expect(metadata.website).toBeNull();
    expect(secret).toEqual({});
  });

  it('mergeForm rebuilds the flat form from item metadata + decrypted secret', () => {
    const item = { id: '1', type: 'login', title: 'Gmail', website: 'mail.google.com', username: 'sandy', tags: null, cardType: null, bankName: null, collection: 'Personal', favorite: false } as unknown as VaultItemDTO;
    const values = mergeForm(def, item, { password: 's3cr3t', totp: '', notes: 'n' });
    expect(values).toMatchObject({ title: 'Gmail', website: 'mail.google.com', username: 'sandy', password: 's3cr3t', notes: 'n', collection: 'Personal' });
  });
});
