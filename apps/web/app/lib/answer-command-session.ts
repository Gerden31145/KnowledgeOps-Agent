export const answerCommandStoragePrefix = 'knowledgeops:answer-command:v1:'

// 标签页内的身份批次；普通路由切换不增加，退出或身份变化后使旧提交回调失效。
let sessionGeneration = 0
export const answerCommandSessionGeneration = () => sessionGeneration

export function reconcileAnswerCommandSession(userId: string | null): void {
  sessionGeneration += 1
  try {
    const storage = window.sessionStorage
    const keepPrefix = userId ? `${answerCommandStoragePrefix}${userId}:` : null
    // 倒序删除避免下标移动漏项；只动本功能的数据，不清理其他浏览器偏好。
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index)
      if (
        key?.startsWith(answerCommandStoragePrefix) &&
        (!keepPrefix || !key.startsWith(keepPrefix))
      )
        storage.removeItem(key)
    }
  } catch {
    // 浏览器禁止访问存储时，表单仍沿用 storageBlocked；旧批次回调仍然失效。
  }
}
