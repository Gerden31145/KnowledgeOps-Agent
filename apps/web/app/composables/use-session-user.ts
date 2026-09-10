import { useState } from '#imports'
import type { SessionResponse } from '@knowledgeops/contracts'

// 只存可展示的身份；Cookie 由浏览器管理，不能由此状态决定 API 访问权限。
export const useSessionUser = () =>
  useState<SessionResponse['user'] | null>('session-user', () => null)
