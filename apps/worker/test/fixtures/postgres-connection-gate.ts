import { createConnection, createServer, type Socket } from 'node:net'

// 测试专用 TCP 入口。只切断通过此入口建立的连接，不关闭真实数据库或用户连接。
export async function postgresConnectionGate(databaseUrl: string) {
  const target = new URL(databaseUrl)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    throw new Error('Expected local test database')
  const sockets = new Set<Socket>()
  let blocked = false
  const server = createServer((incoming) => {
    if (blocked) {
      incoming.destroy()
      return
    }
    const upstream = createConnection({ host: target.hostname, port: Number(target.port || 5432) })
    for (const socket of [incoming, upstream]) {
      sockets.add(socket)
      socket.on('error', () => {
        incoming.destroy()
        upstream.destroy()
      })
      socket.on('close', () => {
        sockets.delete(socket)
        incoming.destroy()
        upstream.destroy()
      })
    }
    incoming.pipe(upstream).pipe(incoming)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP address')
  const connection = new URL(databaseUrl)
  connection.hostname = '127.0.0.1'
  connection.port = String(address.port)
  return {
    url: connection.toString(),
    block() {
      blocked = true
      for (const socket of sockets) socket.destroy()
    },
    restore() {
      blocked = false
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
