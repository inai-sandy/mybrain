import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillsService, parseSkillMd } from './skills.service';

describe('parseSkillMd (BEA-635 block-scalar fix)', () => {
  it('reads a plain single-line description', () => {
    expect(parseSkillMd('---\nname: foo\ndescription: does a thing\n---\nbody')).toEqual({ name: 'foo', description: 'does a thing' });
  });
  it('reads a YAML block-scalar (|-) description instead of the marker', () => {
    const md = '---\nname: claude-api\ndescription: |-\n  Build apps on the Claude API.\n  Covers tool use and streaming.\n---\nbody';
    expect(parseSkillMd(md)).toEqual({ name: 'claude-api', description: 'Build apps on the Claude API. Covers tool use and streaming.' });
  });
});

function fakePrisma(skill: any) {
  return {
    skill: {
      findUnique: async ({ where }: any) => (where.id === skill.id ? skill : null),
      update: async ({ data }: any) => { Object.assign(skill, data); return skill; },
      delete: async () => { skill._deleted = true; return skill; },
    },
  };
}
const fakeMem = { deleteDoc: async () => undefined };

describe('SkillsService — multi-target deploy (BEA-634)', () => {
  let dirs: string[];
  let svc: SkillsService;
  let skill: any;

  beforeEach(async () => {
    const base = await fs.mkdtemp(join(tmpdir(), 'skills-'));
    dirs = [join(base, 'sandy'), join(base, 'hermes')];
    for (const d of dirs) await fs.mkdir(d, { recursive: true });
    process.env.DEPLOY_SKILLS_DIRS = `sandy:${dirs[0]},hermes:${dirs[1]}`;
    skill = { id: 's1', title: 'Deep Research', slug: null, source: null, content: '---\nname: deep-research\n---\nbody', filePath: null, deployments: '{}' };
    svc = new SkillsService(fakePrisma(skill) as any, fakeMem as any, {} as any, {} as any);
  });

  it('deployAll installs into every target and records the per-target map', async () => {
    const res = await svc.deployAll('s1');
    expect(res.ok).toBe(true);
    for (const d of dirs) expect(await fs.readFile(join(d, 'deep-research', 'SKILL.md'), 'utf8')).toContain('name: deep-research');
    expect(JSON.parse(skill.deployments)).toEqual({ sandy: 'deep-research', hermes: 'deep-research' });
  });

  it('deployStatus reflects on-disk reality; undeploy removes one target only', async () => {
    await svc.deployAll('s1');
    let st = await svc.deployStatus('s1');
    expect(st.every((t) => t.installed)).toBe(true);

    const r = await svc.undeploy('s1', 'hermes');
    expect(r.ok).toBe(true);
    st = await svc.deployStatus('s1');
    expect(st.find((t) => t.target === 'hermes')!.installed).toBe(false);
    expect(st.find((t) => t.target === 'sandy')!.installed).toBe(true);
    await expect(fs.stat(join(dirs[1], 'deep-research'))).rejects.toBeTruthy(); // gone from hermes
  });

  it('re-deploying reuses the same folder (stable slug, no name-2)', async () => {
    await svc.deploy('s1', 'sandy');
    await svc.deploy('s1', 'sandy');
    const entries = await fs.readdir(dirs[0]);
    expect(entries.filter((e) => e.startsWith('deep-research'))).toEqual(['deep-research']);
  });

  it('remove(uninstall=false) is library-only — deployed folders stay (BEA-636)', async () => {
    await svc.deployAll('s1');
    await svc.remove('s1', false);
    expect(skill._deleted).toBe(true);
    for (const d of dirs) await fs.stat(join(d, 'deep-research')); // still on disk (no throw)
  });

  it('remove(uninstall=true) deletes the deployed folders AND the skill (BEA-636)', async () => {
    await svc.deployAll('s1');
    await svc.remove('s1', true);
    expect(skill._deleted).toBe(true);
    for (const d of dirs) await expect(fs.stat(join(d, 'deep-research'))).rejects.toBeTruthy(); // gone
  });

  it('deploying to a new target keeps a legacy-tracked target installed (BEA-636 regression)', async () => {
    // legacy state: skill was deployed to hermes via the old single source/slug record (empty map)
    await fs.mkdir(join(dirs[1], 'deep-research'), { recursive: true });
    await fs.writeFile(join(dirs[1], 'deep-research', 'SKILL.md'), 'x', 'utf8');
    skill.slug = 'deep-research'; skill.source = dirs[1]; skill.deployments = '{}';

    await svc.deploy('s1', 'sandy'); // deploy to the OTHER target
    const by = Object.fromEntries((await svc.deployStatus('s1')).map((t) => [t.target, t.installed]));
    expect(by.hermes).toBe(true); // the bug made this false (deselected the already-installed one)
    expect(by.sandy).toBe(true);
  });

  it('never clobbers a DIFFERENT skill already in the target (renames to -2)', async () => {
    await fs.mkdir(join(dirs[0], 'deep-research'), { recursive: true });
    await fs.writeFile(join(dirs[0], 'deep-research', 'SKILL.md'), 'a pre-existing different skill', 'utf8');
    const r = await svc.deploy('s1', 'sandy');
    expect(r.ok).toBe(true);
    expect(await fs.readFile(join(dirs[0], 'deep-research', 'SKILL.md'), 'utf8')).toBe('a pre-existing different skill'); // untouched
    expect(JSON.parse(skill.deployments).sandy).toBe('deep-research-2');
  });
});
