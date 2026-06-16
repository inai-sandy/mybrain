import { Module } from '@nestjs/common';
import { GoogleService } from './google.service';
import { GmailBriefService } from './gmail-brief.service';
import { GoogleController } from './google.controller';
import { ItemsModule } from '../items/items.module';

@Module({
  imports: [ItemsModule],
  providers: [GoogleService, GmailBriefService],
  controllers: [GoogleController],
  exports: [GoogleService, GmailBriefService],
})
export class GoogleModule {}
