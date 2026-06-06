import { NotionService } from './notion.service';

describe('NotionService', () => {
  const noToken = new NotionService({ get: async () => null } as any);

  it('extracts a 32-char page id from a Notion URL', () => {
    expect(noToken.extractPageId('https://www.notion.so/Page-Title-1234567890abcdef1234567890abcdef')).toBe(
      '1234567890abcdef1234567890abcdef',
    );
  });

  it('extracts a dashed page id', () => {
    expect(noToken.extractPageId('12345678-90ab-cdef-1234-567890abcdef')).toBe('1234567890abcdef1234567890abcdef');
  });

  it('throws on a link with no id', () => {
    expect(() => noToken.extractPageId('https://notion.so/nope')).toThrow();
  });

  it('requires the Notion connector to be set', async () => {
    await expect(noToken.fetchMarkdown('https://notion.so/x-1234567890abcdef1234567890abcdef')).rejects.toThrow();
  });
});
