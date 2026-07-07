import { Global, Module } from '@nestjs/common';
import { TrackingService } from './tracking.service';

@Global()
@Module({
  providers: [TrackingService],
  exports: [TrackingService],
})
export class TrackingModule {}
