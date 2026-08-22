import { execFileSync } from 'child_process';
import { join } from 'path';
import { pathToFileURL } from 'url';

/**
 * A worker is an ESM file (`worker.mjs`) on the host, and the kit is copied into its folder. This
 * proves the one thing the app's own tests cannot see: that a real `import { makeKit } from
 * './kit/kit.js'` works on Node, with named exports and no build step. Cheap insurance against a
 * kit that is perfect in Jest and unloadable where it actually runs.
 */
describe('the kit loads the way a generated worker will load it', () => {
  it('imports as ESM, by name, with no dependencies', () => {
    const kit = pathToFileURL(join(__dirname, 'kit', 'kit.js')).href;
    const script = `
      import { makeKit, installDeterminism, KIT_VERSION, WorkerPaused } from ${JSON.stringify(kit)};
      const k = makeKit({ runId: 'r', seed: { now: 42, random: 7 }, fetchImpl: async () => ({ ok: true }) });
      if (typeof makeKit !== 'function' || typeof installDeterminism !== 'function') throw new Error('missing exports');
      if (k.now() !== 42) throw new Error('the frozen clock did not come through');
      if (!(new WorkerPaused('q').paused)) throw new Error('WorkerPaused is not a pause');
      process.stdout.write('kit ' + KIT_VERSION);
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(out).toBe('kit 1');
  });
});
