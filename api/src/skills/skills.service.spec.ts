import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillsService, parseSkillMd, repairSkillMd } from './skills.service';

describe('parseSkillMd (BEA-635 block-scalar fix)', () => {
  it('reads a plain single-line description', () => {
    expect(parseSkillMd('---\nname: foo\ndescription: does a thing\n---\nbody')).toEqual({ name: 'foo', description: 'does a thing' });
  });
  it('reads a YAML block-scalar (|-) description instead of the marker', () => {
    const md = '---\nname: claude-api\ndescription: |-\n  Build apps on the Claude API.\n  Covers tool use and streaming.\n---\nbody';
    expect(parseSkillMd(md)).toEqual({ name: 'claude-api', description: 'Build apps on the Claude API. Covers tool use and streaming.' });
  });
});

describe('repairSkillMd (BEA-977)', () => {
  it('adds a full header when none exists, preserving the body', () => {
    const { content, changed } = repairSkillMd('# My Skill\n\nbody text', 'my-skill');
    expect(changed).toBe(true);
    expect(content).toContain('name: my-skill');
    expect(content).toContain('description: "My Skill"');
    expect(content).toContain('body text');
  });
  it('leaves a valid header untouched', () => {
    const md = '---\nname: x\ndescription: y\n---\nbody';
    expect(repairSkillMd(md, 'fallback')).toEqual({ content: md, changed: false });
  });
  it('fills a missing description from the first body line', () => {
    const { content, changed } = repairSkillMd('---\nname: x\n---\nDoes the thing.\nmore', 'x');
    expect(changed).toBe(true);
    expect(content).toContain('description: "Does the thing."');
  });
});

describe('SkillsService.cleanupScan (BEA-977)', () => {
  const svcWith = (rows: any[]) => new SkillsService({ skill: { findMany: async () => rows } } as any, {} as any, {} as any, {} as any);
  it('flags source-duplicates (keeping the deployed one) and broken headers', async () => {
    const svc = svcWith([
      { id: 'a', title: 'Soft', sourceRepo: 'o/r', skillPath: 'skills/soft', deployments: '{"sandy":"soft"}', content: '---\nname: soft\ndescription: d\n---\nx', createdAt: new Date('2020-01-01') },
      { id: 'b', title: 'Soft', sourceRepo: 'o/r', skillPath: 'skills/soft', deployments: '{}', content: '---\nname: soft\ndescription: d\n---\nx', createdAt: new Date('2020-02-01') },
      { id: 'c', title: 'Bare', deployments: '{}', content: '# no frontmatter here', createdAt: new Date('2020-01-01') },
    ]);
    const rep = await svc.cleanupScan();
    expect(rep.duplicates).toHaveLength(1);
    expect(rep.duplicates[0].keep).toBe('a');
    expect(rep.duplicates[0].remove).toEqual(['b']);
    expect(rep.broken.map((x) => x.id)).toContain('c');
  });
  it('catches a content-identical "-2" rename even when titles differ (BEA-978)', async () => {
    const body = '---\nname: deep-research\ndescription: d\n---\nthe same body';
    const svc = svcWith([
      { id: 'dr', title: 'deep-research', deployments: '{"sandy":"deep-research"}', content: body, createdAt: new Date('2020-01-01') },
      { id: 'dr2', title: 'deep-research-2', deployments: '{}', content: body, createdAt: new Date('2020-02-01') },
    ]);
    const rep = await svc.cleanupScan();
    expect(rep.duplicates).toHaveLength(1);
    expect(rep.duplicates[0].keep).toBe('dr');
    expect(rep.duplicates[0].remove).toEqual(['dr2']);
  });
  it('does NOT group two different imported skills that merely share a name (BEA-984 — would have deleted a real skill)', async () => {
    const svc = svcWith([
      { id: 'a', title: 'design', sourceRepo: 'owner/one', skillPath: 'skills/design', deployments: '{}', content: '---\nname: design\ndescription: a\n---\nAAA', createdAt: new Date('2020-01-01') },
      { id: 'b', title: 'design', sourceRepo: 'owner/two', skillPath: 'skills/design', deployments: '{}', content: '---\nname: design\ndescription: b\n---\nBBB', createdAt: new Date('2020-02-01') },
    ]);
    const rep = await svc.cleanupScan();
    expect(rep.duplicates).toHaveLength(0); // different repos, different content → two real skills, not duplicates
  });
  it('reports nothing when every skill is unique and well-formed', async () => {
    const svc = svcWith([{ id: 'a', title: 'One', deployments: '{}', content: '---\nname: one\ndescription: d\n---\nx', createdAt: new Date() }]);
    const rep = await svc.cleanupScan();
    expect(rep.duplicates).toHaveLength(0);
    expect(rep.broken).toHaveLength(0);
  });
});

function fakePrisma(skill: any) {
  return {
    skill: {
      findUnique: async ({ where }: any) => (where.id === skill.id ? skill : null),
      // deploy()'s slugOwnedByOther check needs this (BEA-984)
      findMany: async ({ where }: any = {}) => (where?.NOT?.id ? [skill].filter((s) => s.id !== where.NOT.id) : [skill]),
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

  it('a zip-backed skill writes the DB content as SKILL.md — a repaired header reaches disk (BEA-983)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AdmZip = require('adm-zip');
    const base = await fs.mkdtemp(join(tmpdir(), 'zipskill-'));
    const src = join(base, 'folder');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(join(src, 'SKILL.md'), '# original, no header', 'utf8'); // the STALE file inside the zip
    await fs.writeFile(join(src, 'extra.txt'), 'support file', 'utf8');
    const zipPath = join(base, 's.zip');
    const z = new AdmZip(); z.addLocalFolder(src); z.writeZip(zipPath);
    skill.filePath = zipPath;
    skill.content = '---\nname: deep-research\ndescription: "repaired"\n---\n\n# original, no header';

    await svc.deploy('s1', 'sandy');
    const onDisk = await fs.readFile(join(dirs[0], 'deep-research', 'SKILL.md'), 'utf8');
    expect(onDisk).toContain('name: deep-research'); // the repair reached disk (the zip's stale copy did NOT win)
    expect(onDisk).toContain('description: "repaired"');
    // the zip still supplies the support files
    expect(await fs.readFile(join(dirs[0], 'deep-research', 'extra.txt'), 'utf8')).toBe('support file');
  });

  it('keeps a script executable through deploy — AdmZip drops modes otherwise (BEA-986)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AdmZip = require('adm-zip');
    const base = await fs.mkdtemp(join(tmpdir(), 'perm-'));
    const src = join(base, 'folder');
    await fs.mkdir(join(src, 'scripts'), { recursive: true });
    await fs.writeFile(join(src, 'SKILL.md'), '---\nname: deep-research\ndescription: d\n---\nbody', 'utf8');
    await fs.writeFile(join(src, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n', 'utf8');
    await fs.chmod(join(src, 'scripts', 'run.sh'), 0o755); // executable BEFORE zipping
    await fs.writeFile(join(src, 'notes.md'), 'plain', 'utf8');
    await fs.chmod(join(src, 'notes.md'), 0o666); // a world-writable non-exec file (what GitHub zips give us)
    const zipPath = join(base, 's.zip');
    const z = new AdmZip(); z.addLocalFolder(src); z.writeZip(zipPath);
    skill.filePath = zipPath;
    skill.content = '---\nname: deep-research\ndescription: d\n---\nbody';

    await svc.deploy('s1', 'sandy');
    const script = await fs.stat(join(dirs[0], 'deep-research', 'scripts', 'run.sh'));
    expect(script.mode & 0o111).toBeTruthy();  // still executable — the skill can actually run it
    expect(script.mode & 0o022).toBeFalsy();   // but not group/world writable
    const plain = await fs.stat(join(dirs[0], 'deep-research', 'notes.md'));
    expect(plain.mode & 0o111).toBeFalsy();    // a plain file must NOT become executable
    expect(plain.mode & 0o022).toBeFalsy();    // and 666 from the zip is normalised away, not replayed
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

  it('installedTargets reports the on-disk targets for list badges (BEA-638)', async () => {
    await svc.deploy('s1', 'sandy');
    expect(await svc.installedTargets(skill)).toEqual(['sandy']);
    await svc.deploy('s1', 'hermes');
    expect((await svc.installedTargets(skill)).sort()).toEqual(['hermes', 'sandy']);
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

  it('does NOT adopt a folder another tracked skill owns — takes the next free name (BEA-984)', async () => {
    // Another skill of ours is already deployed to sandy as "deep-research".
    const other = { id: 'other', title: 'Deep Research', slug: 'deep-research', source: null, content: 'OTHER', filePath: null, deployments: JSON.stringify({ sandy: 'deep-research' }) };
    const me: any = { id: 's2', title: 'Deep Research', slug: null, source: null, content: 'MINE', filePath: null, deployments: '{}' };
    const rows = [other, me];
    const prisma: any = { skill: {
      findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) || null,
      findMany: async ({ where }: any = {}) => (where?.NOT?.id ? rows.filter((r) => r.id !== where.NOT.id) : rows),
      update: async ({ where, data }: any) => { Object.assign(rows.find((r) => r.id === where.id)!, data); return null; },
    } };
    const svc2 = new SkillsService(prisma, fakeMem as any, {} as any, {} as any);
    await fs.mkdir(join(dirs[0], 'deep-research'), { recursive: true });
    await fs.writeFile(join(dirs[0], 'deep-research', 'SKILL.md'), 'OTHER', 'utf8');

    const r = await svc2.deploy('s2', 'sandy');
    expect(r.ok).toBe(true);
    expect(JSON.parse(me.deployments).sandy).toBe('deep-research-2'); // did NOT steal the other skill's folder
    expect(await fs.readFile(join(dirs[0], 'deep-research', 'SKILL.md'), 'utf8')).toBe('OTHER'); // untouched
    expect(await fs.readFile(join(dirs[0], 'deep-research-2', 'SKILL.md'), 'utf8')).toBe('MINE'); // own content written
  });

  it('adopts an already-installed skill of the same name — no "-2", existing folder untouched (BEA-959)', async () => {
    // A skill with this name already lives in the sandy target (e.g. a built-in). Adopt + use it.
    await fs.mkdir(join(dirs[0], 'deep-research'), { recursive: true });
    await fs.writeFile(join(dirs[0], 'deep-research', 'SKILL.md'), 'BUILT-IN', 'utf8');
    const r = await svc.deploy('s1', 'sandy');
    expect(r.ok).toBe(true);
    expect(JSON.parse(skill.deployments).sandy).toBe('deep-research'); // clean name, no "-2"
    expect(await fs.readFile(join(dirs[0], 'deep-research', 'SKILL.md'), 'utf8')).toBe('BUILT-IN'); // adopted, untouched
    await expect(fs.stat(join(dirs[0], 'deep-research-2'))).rejects.toBeDefined(); // no duplicate folder
  });
});

describe('SkillsService.scan — dedup + re-entrancy (BEA-961)', () => {
  function scanFakes(existing: any[]) {
    const skills = [...existing];
    const prisma: any = {
      skill: {
        findMany: async () => skills,
        create: async ({ data }: any) => { const r = { id: 'n' + (skills.length + 1), ...data }; skills.push(r); return r; },
        update: async ({ where, data }: any) => { const s = skills.find((x) => x.id === where.id); Object.assign(s, data); return s; },
      },
      setting: { findUnique: async () => null, upsert: async () => ({}) },
    };
    const svc = new SkillsService(prisma as any, { enqueue: async () => undefined } as any, { complete: async () => 'desc' } as any, { get: async () => 'tmpl' } as any);
    jest.spyOn(svc as any, 'zipFolder').mockResolvedValue(true);
    jest.spyOn(svc as any, 'applyUsage').mockResolvedValue(undefined);
    return { svc, skills };
  }

  it('matches an existing skill by NAME (not slug/origin) — updates, never duplicates', async () => {
    const base = await fs.mkdtemp(join(tmpdir(), 'scan-'));
    await fs.mkdir(join(base, 'design-2'), { recursive: true }); // folder name differs from the tracked slug
    await fs.writeFile(join(base, 'design-2', 'SKILL.md'), '---\nname: design\ndescription: d\n---\nbody', 'utf8');
    process.env.SKILLS_SCAN_DIRS = base;
    process.env.DATA_DIR = base;
    // an imported skill (origin=downloaded, clean slug) — the OLD match (origin:'created', slug) would MISS this
    const { svc, skills } = scanFakes([{ id: 'x1', title: 'design', slug: 'design', origin: 'downloaded', content: 'old', description: 'old' }]);
    const r = await svc.scan();
    expect(r.created).toBe(0);
    expect(r.updated).toBe(1);
    expect(skills.length).toBe(1); // still ONE 'design' record — no duplicate
  });

  it('skips when a scan is already running (re-entrancy guard)', async () => {
    const { svc } = scanFakes([]);
    (svc as any).scanning = true;
    const r = await svc.scan();
    expect(r).toMatchObject({ created: 0, updated: 0, total: 0 });
  });
});
