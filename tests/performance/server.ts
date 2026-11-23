import { createServer } from 'node:http'
import {
  performanceApiOrigin,
  performanceWebOrigin,
  syntheticApiResponse,
  type PerformanceScenario,
} from './fixtures.js'

const origin = new URL(performanceApiOrigin)
const scenarios: PerformanceScenario[] = ['anonymous', 'plan', 'course', 'activity']

createServer((request, response) => {
  const path = new URL(request.url ?? '/', performanceApiOrigin).pathname
  if (request.method === 'GET' && path === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"status":"ok"}')
    return
  }

  const cookies = request.headers.cookie ?? ''
  const scenario =
    scenarios.find((value) => cookies.includes(`performance_scenario=${value}`)) ?? 'anonymous'
  const result = syntheticApiResponse(scenario, request.method ?? 'GET', path)
  const body = result.body === null ? '' : JSON.stringify(result.body)
  response.writeHead(result.status, {
    'access-control-allow-origin': performanceWebOrigin,
    'access-control-allow-credentials': 'true',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(body)
}).listen(Number(origin.port), origin.hostname)
