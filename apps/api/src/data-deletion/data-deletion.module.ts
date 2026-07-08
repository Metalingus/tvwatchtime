import { Module } from '@nestjs/common';
import { DataDeletionController } from './data-deletion.controller';
import { DataDeletionService } from './data-deletion.service';

@Module({
  controllers: [DataDeletionController],
  providers: [DataDeletionService],
})
export class DataDeletionModule {}
