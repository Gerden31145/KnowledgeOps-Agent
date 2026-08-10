import { createDatabaseClient, type DatabaseClient } from '@knowledgeops/database'
import { Injectable, type OnApplicationShutdown } from '@nestjs/common'

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly client: DatabaseClient

  constructor(connectionString: string) {
    this.client = createDatabaseClient(connectionString)
  }

  async onApplicationShutdown() {
    await this.client.$disconnect()
  }
}
