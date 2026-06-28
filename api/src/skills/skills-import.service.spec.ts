import { SkillsImportService } from './skills-import.service';

const P = (u: string) => SkillsImportService.parseGithubUrl(u);

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
