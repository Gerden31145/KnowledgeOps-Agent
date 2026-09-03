import { createDatabaseClient, type DatabaseClient } from '@knowledgeops/database'
import { Injectable } from '@nestjs/common'

@Injectable()
export class DatabaseService {
  readonly client: DatabaseClient

  constructor(connectionString: string) {
    this.client = createDatabaseClient(connectionString)
  }

  async close(): Promise<void> {
    await this.client.$disconnect()
  }
}
