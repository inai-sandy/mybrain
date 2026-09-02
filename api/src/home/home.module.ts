import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { DailyModule } from '../daily/daily.module';
import { MemoryModule } from '../memory/memory.module';
import { ContactsModule } from '../contacts/contacts.module';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';

@Module({
  imports: [TasksModule, DailyModule, MemoryModule, ContactsModule], // Contacts: the review inbox feeds Needs you (BEA-1596)
  controllers: [HomeController],
  providers: [HomeService],
})
export class HomeModule {}
