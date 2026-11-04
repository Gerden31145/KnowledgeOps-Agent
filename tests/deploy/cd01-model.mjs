import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

// Transport fixture only: production Worker/LangChain still parse and validate this response.
export const plan = {
  stages: [
    {
      title: 'CD01 container exercise',
      tasks: ['image', 'network', 'storage'].map((topic, index) => ({
        id: `learn-${topic}`,
        title: `Explain Docker ${topic}`,
        description: `Write a short note explaining Docker ${topic} in this project.`,
        type: 'MARKDOWN_NOTE',
        estimatedMinutes: 30,
        suggestedSteps: ['Observe the running service', 'Explain the observed result'],
        targetPath: `notes/docker/${topic}.md`,
        acceptanceCriteria: [
          {
            type: 'SECTION_PRESENT',
            config: { heading: 'Observation' },
            description: 'Include an Observation heading.',
            required: true,
          },
        ],
        dependsOnTaskIds: index === 0 ? [] : ['learn-image'],
      })),
    },
  ],
}

export function createModelServer() {
  let calls = 0
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'GET' && request.url === '/health') {
      response.end(JSON.stringify({ fixture: 'cd01-model', calls }))
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end(JSON.stringify({ error: 'Unknown fixture route' }))
      return
    }
    try {
      let body = ''
      for await (const chunk of request) {
        body += chunk.toString()
        if (body.length > 262_144) throw new Error('Fixture body too large')
      }
      const input = JSON.parse(body)
      if (
        input.model !== 'cd01-fake' ||
        request.headers.authorization !== 'Bearer cd01-synthetic-key'
      ) {
        response
          .writeHead(400)
          .end(JSON.stringify({ error: 'Only CD01 synthetic requests allowed' }))
        return
      }
      calls += 1
      response.end(
        JSON.stringify({
          id: `cd01-completion-${calls}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'cd01-fake',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: JSON.stringify(plan) },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
        }),
      )
      console.log(JSON.stringify({ event: 'cd01-model-response', calls }))
    } catch {
      response.writeHead(400).end(JSON.stringify({ error: 'Invalid fixture request' }))
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createModelServer()
  server.listen(4100, '0.0.0.0', () => console.log(JSON.stringify({ event: 'cd01-model-ready' })))
  process.once('SIGTERM', () => server.close())
  process.once('SIGINT', () => server.close())
}
