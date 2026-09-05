import { useRuntimeConfig } from '#app'

import { createKnowledgeOpsApi } from '../lib/knowledge-ops-api'

export function useKnowledgeOpsApi() {
  const config = useRuntimeConfig()

  return createKnowledgeOpsApi(config.public.apiBaseUrl)
}
