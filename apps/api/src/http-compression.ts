import compression from 'compression'
import type { RequestHandler } from 'express'

export function createHttpCompression(): RequestHandler {
  return compression({
    threshold: 1024,
    filter: (request, response) => {
      const contentType = String(response.getHeader('Content-Type') ?? '')
      if (contentType.startsWith('text/event-stream')) return false
      return compression.filter(request, response)
    },
  })
}
