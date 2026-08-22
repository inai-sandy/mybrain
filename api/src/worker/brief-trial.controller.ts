import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { BriefTrialService } from './brief-trial.service';

/**
 * The second gate, as the screen sees it (BEA-1408, "Brief First").
 *
 * `GET` says whether there is a trial for the brief he is looking at, what it produced, and — in
 * plain words — why Create is not possible yet. `POST run` starts one. `POST create` keeps it, and
 * refuses unless a passing trial of THIS version of the brief exists.
 *
 * A build turn is a real Codex session and takes minutes, so `run` answers at once and the screen
 * polls `GET`. Nothing here blocks a request for the length of a build.
 */
@Controller('agent/areas/:id/brief/trial')
export class BriefTrialController {
  constructor(private readonly trials: BriefTrialService) {}

  @Get()
  state(@Param('id') id: string) {
    return this.trials.state(id);
  }

  /** Run it once, for real: nothing written, nothing sent. */
  @Post('run')
  async run(@Param('id') id: string) {
    const trial = await this.trials.start(id);
    return { ...(await this.trials.state(id)), trial };
  }

  /** Keep it. Refused, with a reason he can read, until a passing trial of this brief exists. */
  @Post('create')
  create(@Param('id') id: string) {
    return this.trials.create(id);
  }

  /** "Send it back" — one sentence from him, which joins the conversation and starts the next version. */
  @Post('send-back')
  async sendBack(@Param('id') id: string, @Body() body: { note?: string }) {
    await this.trials.sendBack(id, String(body?.note || ''));
    return this.trials.state(id);
  }
}
