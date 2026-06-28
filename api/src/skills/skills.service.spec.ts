import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillsService } from './skills.service';

function fakePrisma(skill: any) {
  return {
    skill: {
      findUnique: async ({ where }: any) => (where.id === skill.id ? skill : null),
      update: async ({ data }: any) => { Object.assign(skill, data); return skill; },
    },
  };
}

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
    svc = new SkillsService(fakePrisma(skill) as any, {} as any, {} as any, {} as any);
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

  it('never clobbers a DIFFERENT skill already in the target (renames to -2)', async () => {
    await fs.mkdir(join(dirs[0], 'deep-research'), { recursive: true });
    await fs.writeFile(join(dirs[0], 'deep-research', 'SKILL.md'), 'a pre-existing different skill', 'utf8');
    const r = await svc.deploy('s1', 'sandy');
    expect(r.ok).toBe(true);
    expect(await fs.readFile(join(dirs[0], 'deep-research', 'SKILL.md'), 'utf8')).toBe('a pre-existing different skill'); // untouched
    expect(JSON.parse(skill.deployments).sandy).toBe('deep-research-2');
  });
});
