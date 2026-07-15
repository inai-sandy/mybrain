import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillsImportService } from './skills-import.service';

const P = (u: string) => SkillsImportService.parseGithubUrl(u);

describe('SkillsImportService bundle builder (BEA-979)', () => {
  it('builds ONE router SKILL.md listing each sub-skill + copies each under styles/', async () => {
    const base = await fs.mkdtemp(join(tmpdir(), 'bundle-'));
    process.env.DATA_DIR = base;
    const root = join(base, 'repo');
    for (const [n, d] of [['soft', 'warm agency look'], ['brutalist', 'raw mechanical look']]) {
      await fs.mkdir(join(root, 'skills', n), { recursive: true });
      await fs.writeFile(join(root, 'skills', n, 'SKILL.md'), `---\nname: ${n}\ndescription: ${d}\n---\nbody ${n}`, 'utf8');
    }
    const svc = new SkillsImportService({} as any);
    const built = await (svc as any).buildBundleFolder(root, ['skills/soft', 'skills/brutalist'], 'taste-skill', 'o/r');
    expect(built.count).toBe(2);
    const router = await fs.readFile(join(built.dir, 'SKILL.md'), 'utf8');
    expect(router).toContain('name: taste-skill');
    expect(router).toContain('**soft**');
    expect(router).toContain('styles/soft/SKILL.md');
    // each sub-skill's full folder is copied inside the bundle
    expect(await fs.readFile(join(built.dir, 'styles', 'brutalist', 'SKILL.md'), 'utf8')).toContain('name: brutalist');
    await fs.rm(built.dir, { recursive: true, force: true }).catch(() => undefined);
  });
});

describe('SkillsImportService.parseGithubUrl (BEA-635)', () => {
  it('plain repo', () => {
    expect(P('https://github.com/anthropics/skills')).toEqual({ owner: 'anthropics', repo: 'skills' });
  });
  it('no scheme + .git', () => {
    expect(P('github.com/owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
  });
  it('tree sub-folder', () => {
    expect(P('https://github.com/anthropics/skills/tree/main/document-skills/pdf')).toEqual({ owner: 'anthropics', repo: 'skills', ref: 'main', subpath: 'document-skills/pdf' });
  });
  it('blob to a SKILL.md → folder', () => {
    expect(P('https://github.com/o/r/blob/dev/skills/foo/SKILL.md')).toEqual({ owner: 'o', repo: 'r', ref: 'dev', subpath: 'skills/foo' });
  });
  it('raw.githubusercontent SKILL.md → folder', () => {
    expect(P('https://raw.githubusercontent.com/o/r/main/a/b/SKILL.md')).toEqual({ owner: 'o', repo: 'r', ref: 'main', subpath: 'a/b' });
  });
  it('git@ ssh form', () => {
    expect(P('git@github.com:owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
  });
  it('rejects non-github + junk', () => {
    expect(() => P('https://gitlab.com/o/r')).toThrow();
    expect(() => P('not a url at all !!')).toThrow();
    expect(() => P('')).toThrow();
  });
});
