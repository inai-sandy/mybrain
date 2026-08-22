import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { WorkerBuildService } from './worker-build.service';
import { WorkerRepairService } from './worker-repair.service';

/**
 * The owner's door to the build turn (BEA-1390 — `specs/AGENT-WORKERS.md` §C, §D).
 *
 * `GET` says what worker a job has, whether it is stale (its plan was edited since it was compiled)
 * and how the last few builds went. `POST build` is the Create/Rebuild tap: one fresh Codex session
 * that compiles the job's approved plan into a new version and puts it live **only** if that
 * version's own tests pass.
 *
 * These are ordinary owner routes behind the global session guard — the worker's own callback API
 * (`/api/worker/*`) is a different thing entirely, reachable only with a run-scoped token.
 */
@Controller('agent/agents/:id/worker')
export class WorkerBuildController {
  constructor(private readonly builds: WorkerBuildService, private readonly repairs: WorkerRepairService) {}

  @Get()
  state(@Param('id') id: string) {
    return this.builds.state(id);
  }

  @Post('build')
  build(@Param('id') id: string, @Body() body: any) {
    return this.builds.build(id, { reason: body?.reason ? String(body.reason).slice(0, 300) : undefined });
  }

  /**
   * The owner's half of the promotion guard (BEA-1393). A repair whose tests passed but whose rows
   * moved is held rather than promoted, and only he decides: **yes** puts that version live,
   * **no** leaves the worker exactly as it is. The loop can never take this decision itself — that
   * is the whole point of holding it. (The buttons that call these are the Worker tab's, BEA-1394.)
   */
  @Post('repairs/:buildId/accept')
  accept(@Param('id') id: string, @Param('buildId') buildId: string) {
    return this.repairs.accept(id, buildId);
  }

  @Post('repairs/:buildId/decline')
  decline(@Param('id') id: string, @Param('buildId') buildId: string) {
    return this.repairs.decline(id, buildId);
  }
}
