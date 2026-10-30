import { Module } from '@nestjs/common'
import { DatabaseService } from '../database/database.service.js'
import { NoteVerificationQueryController } from './note-verification-query.controller.js'
import { NoteVerificationQueryService } from './note-verification-query.service.js'
import { FollowUpAnswerController } from './follow-up-answer.controller.js'
import { FollowUpAnswerService } from './follow-up-answer.service.js'
import { CancelVerificationRunController } from './cancel-verification-run.controller.js'
import { CancelVerificationRunService } from './cancel-verification-run.service.js'
import { RetryNoteVerificationController } from './retry-note-verification.controller.js'
import { RetryNoteVerificationService } from './retry-note-verification.service.js'
import { RetryAnswerVerificationService } from './retry-answer-verification.service.js'

@Module({
  controllers: [
    NoteVerificationQueryController,
    FollowUpAnswerController,
    CancelVerificationRunController,
    RetryNoteVerificationController,
  ],
  providers: [
    {
      provide: RetryAnswerVerificationService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) =>
        new RetryAnswerVerificationService(database.client),
    },
    {
      provide: RetryNoteVerificationService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => new RetryNoteVerificationService(database.client),
    },
    {
      provide: CancelVerificationRunService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => new CancelVerificationRunService(database.client),
    },
    {
      provide: FollowUpAnswerService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => new FollowUpAnswerService(database.client),
    },
    {
      provide: NoteVerificationQueryService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => new NoteVerificationQueryService(database.client),
    },
  ],
})
export class NoteVerificationModule {}
