import { Module } from '@nestjs/common';
import { OgController } from './og.controller';
import { NewsModule } from '../news/news.module';

/** Share-card images for shareable things other than documents. (BEA-1135) */
@Module({
  // NewsModule exports RadarFeedService — the /radar card draws today's hot list (BEA-1326).
  imports: [NewsModule],
  controllers: [OgController],
})
export class OgModule {}
