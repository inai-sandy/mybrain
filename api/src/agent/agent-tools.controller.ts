import { Body, Controller, Get, Post, Query, BadRequestException } from '@nestjs/common';
import { AgentToolsService, SaveDocInput, SearchBrainInput, AskUserInput } from './agent-tools.service';

/**
 * REST surface for the agent tools (BEA-622). Behind the global auth guard — used by the
 * in-app run and for verifying the tools live. Hermes calls the SAME capabilities over MCP.
 */
@Controller('agent/tools')
export class AgentToolsController {
  constructor(private readonly tools: AgentToolsService) {}

  @Post('save-document')
  saveDocument(@Body() body: SaveDocInput) {
    return this.tools.saveDocument(body);
  }

  @Post('search-brain')
  searchBrain(@Body() body: SearchBrainInput) {
    return this.tools.searchBrain(body);
  }

  @Post('ask-user')
  askUser(@Body() body: AskUserInput) {
    return this.tools.askUser(body);
  }

  @Post('remember')
  remember(@Body() body: { text?: string; tags?: string[] }) {
    return this.tools.remember(body as any);
  }

  @Get('answer')
  getAnswer(@Query('token') token?: string) {
    if (!token) throw new BadRequestException('Missing token');
    return this.tools.getAnswer(token);
  }
}
