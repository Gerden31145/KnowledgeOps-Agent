import { Module } from '@nestjs/common'
import { DatabaseService } from '../database/database.service.js'
import { NoteVerificationQueryController } from './note-verification-query.controller.js'
import { NoteVerificationQueryService } from './note-verification-query.service.js'

@Module({
  controllers: [NoteVerificationQueryController],
  providers: [
    {
      provide: NoteVerificationQueryService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => new NoteVerificationQueryService(database.client),
    },
  ],
})
export class NoteVerificationModule {}
