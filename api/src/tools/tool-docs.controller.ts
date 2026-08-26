import { Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ToolDocsService } from './tool-doc.service';
import { TryActionService } from './try-action.service';

/**
 * THE TOOL DOCUMENTS (BEA-1468) — what Codex reads before it builds anything.
 *
 * The owner: *"Each tool should have a document… Codex should have full access to all the tools and
 * actions… If the context is not proper, it cannot create the right agent that we are looking for."*
 *
 * Four routes, and the shape of them is the design: an INDEX of everything, one tool's whole
 * document, one action's full detail, and a rebuild. Codex pulls down that path itself — nothing
 * here pushes a selection at it, which is the habit these documents exist to end.
 *
 * The owner can read every one of them too. A document he can open is a document he can correct.
 */
@Controller('tools/docs')
export class ToolDocsController {
  constructor(
    private readonly docs: ToolDocsService,
    // Optional + LAST — spec harnesses build this controller with the documents alone.
    private readonly tries?: TryActionService,
  ) {}

  /**
   * Try one action for real, while building (BEA-1484).
   *
   * Reads only, budgeted per build, and every call lands in his ledger. This is what stops Codex
   * writing a program blind and finding out what is true by failing in production.
   */
  @Post('try')
  async try(@Body() body: any) {
    if (!this.tries) return { ok: false, refused: 'Trying actions is not available on this server.' };
    return this.tries.run(String(body?.build || 'build'), String(body?.actionId || ''), body?.args || {});
  }

  /** Every tool, with how many actions it has. The "what do I even have?" answer. */
  @Get()
  async list(@Query('as') as?: string) {
    if (String(as || '') === 'text') return { text: await this.docs.indexText() };
    return { tools: await this.docs.list() };
  }

  /**
   * One action's full detail: its exact parameters, the fields real answers have carried, what it
   * has cost, whether it is failing right now, and any trap written down about it.
   *
   * Declared BEFORE `:service` on purpose — Nest matches routes in order, and an action id contains
   * a dot and a colon that would otherwise be swallowed by the service route.
   */
  @Get('action/:actionId')
  async action(@Param('actionId') actionId: string) {
    const got = await this.docs.action(actionId);
    if (!got) throw new NotFoundException(`Nothing in the catalog is called ${actionId}.`);
    return got;
  }

  /** One tool's document — what it is, and every action it has. */
  @Get(':service')
  async one(@Param('service') service: string) {
    const doc = await this.docs.get(service);
    if (!doc) throw new NotFoundException(`There is no tool called "${service}". Ask for the list first.`);
    return doc;
  }

  /** Rebuild them all from the catalog. Runs daily on its own; this is for "now, please". */
  @Post('rebuild')
  rebuild() {
    return this.docs.rebuild();
  }
}
