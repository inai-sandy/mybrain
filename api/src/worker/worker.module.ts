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
import { OwnerAskService } from './owner-ask.service';
import { WorkerSweeperService } from './worker-sweeper.service';

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
 *
 * And the question road (BEA-1392): `OwnerAskService` sends a parked run's question to the owner's
 * phone and reads his reply back — it registers itself on the callback controller's registry at
 * boot rather than being imported by ContactsModule, which would be a cycle. `WorkerSweeperService`
 * is the worker road's own resume sweeper, its 12-hour deadline, and the stall watchdog that covers
 * the plan runner too.
 */
@Module({
  imports: [AgentModule, SocialModule, ToolCatalogModule, PushModule], // PrismaModule + LlmModule are @Global
  controllers: [WorkerController, WorkerBuildController],
  providers: [RunJournalService, WorkerTokenService, WorkerTokenGuard, WorkerRunnerClient, WorkerBuildService, OwnerAskService, WorkerSweeperService],
  exports: [RunJournalService, WorkerTokenService, WorkerBuildService, OwnerAskService],
})
export class WorkerModule {}
