import { Module } from '@nestjs/common';
import { OgController } from './og.controller';

/** Share-card images for shareable things other than documents. (BEA-1135) */
@Module({
  controllers: [OgController],
})
export class OgModule {}
