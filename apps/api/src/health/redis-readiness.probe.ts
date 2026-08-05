import { createClient } from 'redis'

import type { DependencyProbe } from './dependency-probe.js'

export class RedisReadinessProbe implements DependencyProbe {
  private readonly client

  constructor(connectionUrl: string) {
    this.client = createClient({
      url: connectionUrl,
      socket: {
        connectTimeout: 1_500,
        reconnectStrategy: false,
      },
    })

    // node-redis requires an error listener even though readiness converts failures to "down".
    this.client.on('error', () => undefined)
  }

  async check() {
    if (!this.client.isOpen) {
      await this.client.connect()
    }

    const response = await this.client.ping()

    if (response !== 'PONG') {
      throw new Error('Redis PING returned an unexpected response')
    }
  }

  async close() {
    if (this.client.isOpen) {
      await this.client.quit().catch(() => this.client.destroy())
    }
  }
}
