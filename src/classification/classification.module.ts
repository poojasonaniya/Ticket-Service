import { Module } from '@nestjs/common';
import { ClassificationQueueService } from './classification-queue.service';
import { FakeLlmClientService } from './fake-llm-client.service';
import { LLM_CLIENT } from './llm-client.interface';

@Module({
  providers: [
    ClassificationQueueService,
    { provide: LLM_CLIENT, useClass: FakeLlmClientService },
  ],
  exports: [ClassificationQueueService],
})
export class ClassificationModule {}
