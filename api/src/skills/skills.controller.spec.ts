import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { SkillsController } from './skills.controller';

/**
 * Route ORDER, not route behaviour (BEA-1224).
 *
 * `GET /api/skills/targets` shipped below `@Get(':id')` and Nest, which matches in declaration
 * order, handed every request to the wildcard — so the endpoint answered `{"message":"Skill not
 * found"}` with a 400 while the code itself was perfectly correct. Nothing failed loudly: the page
 * simply fell back to its built-in labels, which is exactly the quiet-failure pattern this project
 * keeps hitting. A unit test on `targets()` would still have passed, so this asserts the one thing
 * that was actually broken.
 */
describe('SkillsController route order', () => {
  const routes = Object.getOwnPropertyNames(SkillsController.prototype)
    .filter((k) => k !== 'constructor')
    .map((k) => ({
      name: k,
      path: Reflect.getMetadata(PATH_METADATA, (SkillsController.prototype as any)[k]),
      method: Reflect.getMetadata(METHOD_METADATA, (SkillsController.prototype as any)[k]),
    }))
    .filter((r) => typeof r.path === 'string');

  const gets = routes.filter((r) => r.method === RequestMethod.GET);
  const at = (path: string) => gets.findIndex((r) => r.path === path);

  it('declares GET /targets before the :id wildcard, or it is unreachable', () => {
    expect(at('targets')).toBeGreaterThanOrEqual(0);
    expect(at(':id')).toBeGreaterThanOrEqual(0);
    expect(at('targets')).toBeLessThan(at(':id'));
  });

  it('keeps EVERY fixed GET path above the :id wildcard', () => {
    const wildcard = at(':id');
    const swallowed = gets
      .filter((r, i) => i > wildcard && !r.path.startsWith(':') && !r.path.includes('/'))
      .map((r) => `${r.name} -> GET /${r.path}`);
    expect(swallowed).toEqual([]);
  });
});
