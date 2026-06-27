import { InstagramEnricher } from './instagram.service';

const svc = () => new InstagramEnricher({ get: async () => null } as any);

describe('InstagramEnricher (BEA-609)', () => {
  it('detects Instagram post/reel/tv URLs only', () => {
    const s = svc();
    expect(s.isInstagram('https://www.instagram.com/p/Cabc123/')).toBe(true);
    expect(s.isInstagram('https://instagram.com/reel/Cxyz/')).toBe(true);
    expect(s.isInstagram('https://www.instagram.com/tv/Cabc/')).toBe(true);
    expect(s.isInstagram('https://youtube.com/watch?v=x')).toBe(false);
    expect(s.isInstagram('https://example.com/instagram')).toBe(false);
  });

  it('parses the real caption + best image from an Apify item', () => {
    const s = svc();
    const out = s.parse({
      caption: 'Three ways to wire a 3-phase meter — full demo',
      type: 'Video',
      videoUrl: 'https://cdn/video.mp4',
      displayUrl: 'https://cdn/thumb.jpg',
      ownerUsername: 'kiot',
    });
    expect(out).toEqual({ caption: 'Three ways to wire a 3-phase meter — full demo', imageUrl: 'https://cdn/thumb.jpg', isVideo: true, owner: 'kiot' });
  });

  it('falls back through image fields and returns null when there is nothing', () => {
    const s = svc();
    expect(s.parse({ caption: 'hi', images: ['https://cdn/i.jpg'] })?.imageUrl).toBe('https://cdn/i.jpg');
    expect(s.parse({ images: [], caption: '' })).toBeNull();
    expect(s.parse(null)).toBeNull();
  });

  it('enrich() returns null when no Apify token is configured', async () => {
    expect(await svc().enrich('https://www.instagram.com/p/Cabc/')).toBeNull();
  });
});
