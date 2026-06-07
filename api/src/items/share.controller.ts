import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ItemsService } from './items.service';
import { Public } from '../auth/public.decorator';

/** Public, unauthenticated read of an item the owner has explicitly shared. */
@Controller('share')
export class ShareController {
  constructor(private readonly items: ItemsService) {}

  @Public()
  @Get(':id')
  async get(@Param('id') id: string) {
    const doc = await this.items.getShared(id);
    if (!doc) throw new NotFoundException('This link is not shared (or no longer shared).');
    return doc;
  }
}
