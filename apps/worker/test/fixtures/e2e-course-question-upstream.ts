import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export function createCourseQuestionUpstream(port = 4500) {
  const calls: { body: string; maxTokens: unknown }[] = []
  const state = {
    failNext: false,
    exerciseOutcome: 'PASSED' as 'PASSED' | 'FAILED' | 'INSUFFICIENT_EVIDENCE',
  }
  const server = createServer((request, response) => {
    void handle(request, response)
  })
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    for await (const chunk of request) body += String(chunk)
    const parsed = JSON.parse(body) as { max_tokens?: unknown; max_completion_tokens?: unknown }
    calls.push({ body, maxTokens: parsed.max_tokens ?? parsed.max_completion_tokens })
    if (state.failNext) {
      state.failNext = false
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'synthetic upstream failure' } }))
      return
    }
    const content = body.includes('course-exercise-v1')
      ? {
          outcome: state.exerciseOutcome,
          rationale:
            state.exerciseOutcome === 'PASSED'
              ? '回答体现了正确的调度顺序。'
              : '回答缺少关键调度顺序。',
          suggestions:
            state.exerciseOutcome === 'PASSED' ? [] : ['补充当前任务、微任务与渲染的顺序。'],
        }
      : {
          answer: '微任务会在当前调用栈清空后、下一次渲染前执行；可以结合本节情景理解这个顺序。',
        }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        id: 'chatcmpl-r16-course-question',
        object: 'chat.completion',
        created: 0,
        model: 'r16-fixture',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify(content),
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    )
  }
  return {
    calls,
    state,
    async start() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => resolve())
      })
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
