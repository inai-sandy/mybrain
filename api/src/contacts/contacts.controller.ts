import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ContactsService } from './contacts.service';
import { ProfileWriterService } from './profile-writer.service';
import { localDayKey } from '../common/localday';

@Controller('contacts')
export class ContactsController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly profiles: ProfileWriterService,
  ) {}

  @Get()
  list(@Query('q') q?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('include') include?: string) {
    const scope = include === 'left' || include === 'all' ? include : 'active';
    return this.contacts.list(q || undefined, Number(page) || 1, Number(pageSize) || 20, scope);
  }

  /**
   * They have left the organisation. (BEA-1307)
   *
   * Stops every chase, turns off their page, takes them out of the pickers — and keeps every word,
   * briefing and message. Returns their still-open work, because what happens to it is the owner's
   * decision, not something to be made silently on his behalf.
   */
  @Post(':id/left')
  markLeft(@Param('id') id: string, @Body() body: { note?: string }) {
    return this.contacts.markLeft(id, body?.note);
  }

  /** They are back. Chases are not resurrected — restarting them is a decision, one at a time. */
  @Post(':id/back')
  markBack(@Param('id') id: string) {
    return this.contacts.markBack(id);
  }

  /** Every contact, name + spellings only — for pickers and @mention matching. Must come before
   *  ':id' so "all" isn't read as an id. Uncapped on purpose: a picker that silently stops at 100
   *  would quietly hide people. (BEA-1019) */
  @Get('all')
  all() {
    return this.contacts.allForPicker();
  }

  /** How this person stands right now. (BEA-1037) */
  @Get(':id/state')
  state(@Param('id') id: string) {
    return this.contacts.state(id);
  }

  /** Write every due character profile NOW — for a first fill and for testing. (BEA-1216) */
  @Post('profiles/run')
  async runProfiles() {
    const week = this.profiles.weekStartOf(localDayKey());
    const written = await this.profiles.writeAll(week);
    return { ok: true, written, week };
  }

  /** The team board: contacts with their work signals for the list page. (BEA-1219) */
  @Get('board')
  board(@Query('q') q?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('include') include?: string) {
    const scope = include === 'left' || include === 'all' ? include : 'active';
    return this.contacts.board(q || undefined, Number(page) || 1, Number(pageSize) || 20, scope);
  }

  /** The weekly character profile. Empty until the weekly writer ships (BEA-1216) — the page
   *  already has its accordion, so the slot answers cleanly rather than 404ing. (BEA-1215) */
  @Get(':id/profile')
  profile(@Param('id') id: string) {
    return this.contacts.profile(id);
  }

  /** Rewrite ONE contact's profile right now — the accordion's refresh button. (BEA-1222) */
  @Post(':id/profile/refresh')
  async refreshProfile(@Param('id') id: string) {
    const ok = await this.profiles.writeOne(id, this.profiles.weekStartOf(localDayKey())).catch(() => false);
    const p = await this.contacts.profile(id);
    return { ok, ...p };
  }

  /** The contact's own link — created on first ask. (BEA-1027) */
  @Get(':id/share')
  share(@Param('id') id: string) {
    return this.contacts.share(id);
  }

  /** Issue a new link and kill the old one. */
  @Post(':id/share/rotate')
  rotateShare(@Param('id') id: string) {
    return this.contacts.rotateShare(id);
  }

  /** Turn their page off or back on. */
  @Post(':id/share/enabled')
  setShareEnabled(@Param('id') id: string, @Body() body: { enabled?: boolean }) {
    return this.contacts.setShareEnabled(id, body?.enabled !== false);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.contacts.get(id);
  }

  @Get(':id/alias-suggestions')
  aliasSuggestions(@Param('id') id: string) {
    return this.contacts.aliasSuggestions(id);
  }

  @Post(':id/alias')
  addAlias(@Param('id') id: string, @Body() body: { alias?: string }) {
    return this.contacts.addAlias(id, body?.alias || '');
  }

  @Post()
  create(@Body() body: { name?: string; whatsappNumber?: string; notes?: string; tags?: string[]; aliases?: string[] }) {
    return this.contacts.create(body || {});
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { name?: string; whatsappNumber?: string; notes?: string; tags?: string[]; aliases?: string[] }) {
    return this.contacts.update(id, body || {});
  }

  /** Refuses when there is real history to lose, unless the owner insists. (BEA-1307) */
  @Delete(':id')
  remove(@Param('id') id: string, @Query('force') force?: string) {
    return this.contacts.remove(id, force === '1' || force === 'true');
  }
}
