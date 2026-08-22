import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { PushModule } from '../push/push.module';
import { SocialModule } from '../social/social.module';
import { ToolCatalogModule } from '../tools/tool-catalog.module';
import { RunJournalService } from './run-journal.service';
import { WorkerBuildController } from './worker-build.controller';
import { WorkerBuildService } from './worker-build.service';
import { WorkerController } from './worker.controller';
import { WorkerRunnerClient } from './worker-runner.client';
import { WorkerTokenGuard } from './worker-token.guard';
import { WorkerTokenService } from './worker-token.service';

/**
 * Agent workers (BEA-1387 — `specs/AGENT-WORKERS.md`): the callback API a worker program on the host
 * calls back into, the run-scoped tokens that let it in, and the journal that makes a pause free.
 *
 * It sits ABOVE Social and Agent and nothing imports it back, so there is no cycle: the fetcher, the
 * shaping step, the sheet writer and the owner alerts are the ones the plan runner already uses.
 * The worker runner itself (the host service that spawns a worker) is a later piece — until then the
 * kit is exercised in-process by its tests.
 *
 * The build turn (BEA-1390) lives here too: it compiles a job's approved plan into a worker through
 * the host runner and decides — on the tests, and only on the tests — whether that version goes live.
 */
@Module({
  imports: [AgentModule, SocialModule, ToolCatalogModule, PushModule], // PrismaModule + LlmModule are @Global
  controllers: [WorkerController, WorkerBuildController],
  providers: [RunJournalService, WorkerTokenService, WorkerTokenGuard, WorkerRunnerClient, WorkerBuildService],
  exports: [RunJournalService, WorkerTokenService, WorkerBuildService],
})
export class WorkerModule {}
