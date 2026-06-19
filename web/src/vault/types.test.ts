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

describe('high-stakes types (BEA-350)', () => {
  it('bank account: name searchable, account number encrypted, last-4 derived to metadata', () => {
    const { metadata, secret } = splitForm(typeDef('bank'), { title: 'HDFC', bank: 'HDFC Bank', holder: 'Sandeep', number: '123456789012', ifsc: 'HDFC0001' });
    expect(metadata.bankName).toBe('HDFC Bank');
    expect(metadata.username).toBe('9012'); // last-4 only
    expect(Object.values(metadata)).not.toContain('123456789012'); // full number never in metadata
    expect(secret.number).toBe('123456789012');
    expect(secret.ifsc).toBe('HDFC0001');
  });

  it('crypto wallet: seed phrase + private key are flagged reauth, address/network are not', () => {
    const fields = typeDef('crypto').fields;
    expect(fields.find((f) => f.key === 'seed')?.reauth).toBe(true);
    expect(fields.find((f) => f.key === 'privateKey')?.reauth).toBe(true);
    expect(fields.find((f) => f.key === 'address')?.reauth).toBeFalsy();
    // and they are secret (no metadata column)
    expect(fields.find((f) => f.key === 'seed')?.meta).toBeUndefined();
  });

  it('api secret: service is searchable metadata, key/secret are encrypted', () => {
    const { metadata, secret } = splitForm(typeDef('apisecret'), { title: 'OpenAI', service: 'OpenAI', key: 'ck_123', secret: 'sk_live_xyz' });
    expect(metadata.username).toBe('OpenAI');
    expect(Object.values(metadata)).not.toContain('sk_live_xyz');
    expect(secret).toEqual({ key: 'ck_123', secret: 'sk_live_xyz' });
  });

  it('identity: government id stays out of metadata', () => {
    const { metadata, secret } = splitForm(typeDef('identity'), { title: 'Passport', fullName: 'Sandeep', govId: 'ABCDE1234F' });
    expect(Object.values(metadata)).not.toContain('ABCDE1234F');
    expect(secret.govId).toBe('ABCDE1234F');
  });
});
