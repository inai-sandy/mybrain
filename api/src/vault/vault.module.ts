import { Module } from '@nestjs/common';
import { VaultController } from './vault.controller';
import { VaultService } from './vault.service';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [MemoryModule], // label-only indexing of vault items (BEA-368)
  controllers: [VaultController],
  providers: [VaultService],
  exports: [VaultService],
})
export class VaultModule {}
