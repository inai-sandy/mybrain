import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { HermesModule } from '../hermes/hermes.module';
import { PushModule } from '../push/push.module';
import { SocialModule } from '../social/social.module';
import { ToolCatalogModule } from '../tools/tool-catalog.module';
import { RunJournalService } from './run-journal.service';
import { WorkerBuildController } from './worker-build.controller';
import { TrialService } from './trial.service';
import { GoalTrialService } from './goal-trial.service';
import { BriefTrialService } from './brief-trial.service';
import { BriefTrialController } from './brief-trial.controller';
import { WorkerBuildService } from './worker-build.service';
import { WorkerController } from './worker.controller';
import { WorkerRunnerClient } from './worker-runner.client';
import { WorkerTokenGuard } from './worker-token.guard';
import { WorkerTokenService } from './worker-token.service';
import { OwnerAskService } from './owner-ask.service';
import { WorkerSweeperService } from './worker-sweeper.service';
import { WorkerRepairService } from './worker-repair.service';
import { WorkerDispatchService } from './worker-dispatch.service';

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
 *
 * And self-heal (BEA-1393): `WorkerRepairService` catches a failed worker run at `finishRun()`, keeps
 * the answer that broke it, and gives Codex two tries — against saved answers only, never a vendor —
 * with a promotion guard that holds back any repair which changes what the agent returns.
 *
 * And the switch that makes any of it run (BEA-1394): `WorkerDispatchService` registers itself on
 * `HermesBridgeService.startRun()` — the one door every start comes through — and decides, per run,
 * whether this job goes down the worker road. That is why this module imports HermesModule; nothing
 * in Hermes imports back, so there is still no cycle.
 */
@Module({
  imports: [AgentModule, SocialModule, ToolCatalogModule, PushModule, HermesModule], // PrismaModule + LlmModule are @Global
  controllers: [BriefTrialController, WorkerController, WorkerBuildController],
  providers: [TrialService, GoalTrialService, BriefTrialService, RunJournalService, WorkerTokenService, WorkerTokenGuard, WorkerRunnerClient, WorkerBuildService, OwnerAskService, WorkerSweeperService, WorkerRepairService, WorkerDispatchService],
  exports: [TrialService, GoalTrialService, BriefTrialService, RunJournalService, WorkerTokenService, WorkerBuildService, OwnerAskService, WorkerRepairService, WorkerDispatchService],
})
export class WorkerModule {}
