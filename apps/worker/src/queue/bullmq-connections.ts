import type { ConnectionOptions } from 'bullmq'

// 生产者快速失败交给 Outbox 退避；常驻消费者等待 Redis 恢复。
export function bullMqProducerConnection(url: string): ConnectionOptions {
  return {
    url,
    commandTimeout: 2_000,
    connectTimeout: 2_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  }
}

export function bullMqWorkerConnection(url: string): ConnectionOptions {
  return { url, maxRetriesPerRequest: null }
}
