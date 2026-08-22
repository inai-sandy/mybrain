/**
 * The kit this app is running, told to the runner on every spawn so it can refuse a worker built for
 * a NEWER one (`specs/AGENT-WORKERS.md` §F — the rollback guard).
 *
 * The kit is a plain JS file that only reaches the image through the Dockerfile's own copy, so it is
 * read defensively: a missing parts box must never stop the app from booting, and the runner makes
 * the same decision from the worker's own `meta.json` either way.
 *
 * It lives in its own file because two callers need it — the resume sweeper (BEA-1392) and the
 * dispatch switch (BEA-1394) — and a second copy of a version number is how the two drift apart.
 */
export function kitVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return String(require('./kit/kit.js').KIT_VERSION || '1');
  } catch {
    return '1';
  }
}
