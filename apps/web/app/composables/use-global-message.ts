import { useState } from '#imports'

export type GlobalMessageTone = 'success' | 'info'
export interface GlobalMessage {
  id: number
  text: string
  tone: GlobalMessageTone
}

let dismissalTimer: number | undefined
let nextMessageId = 0

export function useGlobalMessage() {
  const message = useState<GlobalMessage | null>('global-message', () => null)

  function dismissMessage(id?: number) {
    if (id !== undefined && message.value?.id !== id) return
    if (dismissalTimer !== undefined) window.clearTimeout(dismissalTimer)
    dismissalTimer = undefined
    message.value = null
  }

  function showMessage(text: string, tone: GlobalMessageTone = 'success') {
    const id = ++nextMessageId
    message.value = { id, text, tone }
    if (!import.meta.client) return
    if (dismissalTimer !== undefined) window.clearTimeout(dismissalTimer)
    dismissalTimer = window.setTimeout(() => dismissMessage(id), 4_000)
  }

  return { message, showMessage, dismissMessage }
}
