import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * The migration history and schema.prisma agree (BEA-1262).
 *
 * When they drift, `prisma migrate dev` silently folds a REPAIR into the next unrelated migration.
 * On SQLite that repair is a `RedefineTables` block: create a copy, `INSERT…SELECT`, **DROP the
 * live table**, rename. It works only while the generated column list stays complete — and the day
 * someone changes a column, the copy quietly leaves data behind.
 *
 * A single stray `DEFAULT CURRENT_TIMESTAMP` on `AgentArea.updatedAt`, added 2026-07-25, put a
 * silent DROP of the owner's agents into four separate migrations in one night. Each was caught by
 * reading the generated SQL, which is not a control you can rely on twice.
 *
 * This asserts the drift is zero. If it fails, do NOT hand-strip the block from your migration:
 * write one deliberate migration that fixes the schema/history mismatch, and verify it against a
 * copy of the production database first.
 */
describe('the migration history matches the schema', () => {
  it('produces an EMPTY diff — no repair is waiting to ride along with the next migration', () => {
    const api = join(__dirname, '../..');
    const shadowDir = mkdtempSync(join(tmpdir(), 'prisma-drift-'));
    try {
      const out = execFileSync(
        'npx',
        [
          'prisma',
          'migrate',
          'diff',
          '--from-migrations',
          'prisma/migrations',
          '--to-schema-datamodel',
          'prisma/schema.prisma',
          '--shadow-database-url',
          `file:${join(shadowDir, 'shadow.db')}`,
          '--script',
        ],
        { cwd: api, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );

      const sql = out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('--'))
        .join('\n');

      // Named explicitly so a failure reads as the real problem rather than "string not empty".
      expect({ drift: sql || 'none' }).toEqual({ drift: 'none' });
    } finally {
      rmSync(shadowDir, { recursive: true, force: true });
    }
  }, 120_000);
});
