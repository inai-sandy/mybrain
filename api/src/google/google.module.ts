import { Module } from '@nestjs/common';
import { GoogleService } from './google.service';
import { GoogleController } from './google.controller';
import { ItemsModule } from '../items/items.module';

@Module({
  imports: [ItemsModule],
  providers: [GoogleService],
  controllers: [GoogleController],
  exports: [GoogleService],
})
export class GoogleModule {}
