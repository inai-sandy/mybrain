import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { WorkerBuildService } from './worker-build.service';

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
  constructor(private readonly builds: WorkerBuildService) {}

  @Get()
  state(@Param('id') id: string) {
    return this.builds.state(id);
  }

  @Post('build')
  build(@Param('id') id: string, @Body() body: any) {
    return this.builds.build(id, { reason: body?.reason ? String(body.reason).slice(0, 300) : undefined });
  }
}
