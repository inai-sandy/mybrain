import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * IPv6 TO AWS BLACKHOLES ON THIS BOX (BEA-1511).
 *
 * His ESP32 agent failed with `fetch failed (ETIMEDOUT)` and so did every retry. Measured inside the
 * container: forced IPv4 reached the vendor in 959ms, the default path died in 528ms, and raw TCP to
 * the same addresses connected in 290ms — so neither routing nor the vendor was at fault.
 *
 * `--dns-result-order=ipv4first` was already set and did nothing, because Node 20+ races both
 * families with `autoSelectFamily` whatever the lookup returned. 528ms is two 250ms attempts.
 *
 * This lives in `main.ts` rather than the deploy environment because an env var is one edit away from
 * being lost, and losing it is a silent outage of every agent that talks to a dual-stack vendor.
 * This test is what stops it being "tidied up" later.
 */
describe('the app does not race IPv6 it cannot use', () => {
  const main = () => readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');

  it('turns Happy Eyeballs off at boot', () => {
    expect(main()).toContain('setDefaultAutoSelectFamily(false)');
  });

  it('does it before anything else can open a socket', () => {
    // Nest builds its providers on the first import; a fix applied after that would miss the very
    // first outbound call, which on a scheduled agent is the whole run.
    const t = main();
    expect(t.indexOf('setDefaultAutoSelectFamily(false)')).toBeLessThan(t.indexOf('NestFactory.create'));
  });

  it('says WHY, with the numbers, so nobody deletes it as a mystery line', () => {
    const t = main();
    expect(t).toContain('ETIMEDOUT');
    expect(t).toContain('ipv4first');
  });
});
