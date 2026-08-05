import { SERVICE_NAMES } from '@knowledgeops/contracts'
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'

import { readWorkerEnvironment, type WorkerEnvironment } from './config/environment.js'

const IDLE_HEARTBEAT_INTERVAL_MS = 60_000

@Injectable()
export class WorkerRuntimeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly environment: WorkerEnvironment = readWorkerEnvironment()
  private readonly logger = new Logger(WorkerRuntimeService.name)
  private idleHeartbeat: NodeJS.Timeout | undefined

  onApplicationBootstrap() {
    this.logger.log(
      `${SERVICE_NAMES[2]} process ready (planned concurrency: ${this.environment.WORKER_CONCURRENCY})`,
    )

    // BullMQ will own the active event-loop handle in stage 3. Until then this
    // explicit heartbeat keeps the standalone Nest application alive.
    this.idleHeartbeat = setInterval(() => undefined, IDLE_HEARTBEAT_INTERVAL_MS)
  }

  onApplicationShutdown() {
    if (this.idleHeartbeat) {
      clearInterval(this.idleHeartbeat)
    }
  }
}
