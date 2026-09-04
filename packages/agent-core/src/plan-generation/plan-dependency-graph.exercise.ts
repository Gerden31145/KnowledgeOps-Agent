import type { PlanGenerationOutput } from './plan-generation.js'

export class PlanGenerationDependencyCycleError extends Error {
  override readonly name = 'PlanGenerationDependencyCycleError'

  constructor() {
    super('Generated plan dependencies must form a directed acyclic graph')
  }
}

/**
 * Day 08-10 handwrite boundary.
 *
 * Return true when any dependency cycle exists across the complete generated
 * plan, including cycles whose tasks live in different stages.
 */

// 遍历所有节点，使用Map<taskId, next[]>存储节点，
// 第二次遍历所有节点，遍历该节点的depsTask，设置graph.set(depsTaskid, arr.push(taskid))
// 设置inDegree<taskId, number>，每个节点的入度即deps.length

// 拓扑排序：使用队列储存入度为0的节点
// 取出头节点，遍历他的所有后继节点，将这些后继的入度-1
// 如果有后继的入度为0，那么将其加入队列

export function hasPlanGenerationDependencyCycle(plan: PlanGenerationOutput): boolean {
  const graph = new Map<string, string[]>()
  const inDegree = new Map<string, number>()
  let count = 0
  plan.stages.forEach((stage) => {
    stage.tasks.forEach((task) => {
      graph.set(task.id, [])
      inDegree.set(task.id, task.dependsOnTaskIds.length)
      count++
    })
  })

  plan.stages.forEach((stage) => {
    stage.tasks.forEach((task) => {
      task.dependsOnTaskIds.forEach((id) => {
        const next = graph.get(id)!
        next.push(task.id) // 设置后继
      })
    })
  })

  // 拓扑排序
  const queue = []
  let head = 0
  for (const task of inDegree) {
    if (task[1] === 0) {
      queue.push(task[0])
    }
  }

  while (head !== queue.length) {
    const taskId = queue[head]!
    const next = graph.get(taskId)!
    next.forEach((id) => {
      inDegree.set(id, inDegree.get(id)! - 1)
      if (inDegree.get(id) === 0) {
        queue.push(id)
      }
    })
    head++
  }

  return head !== count
}

export function assertPlanGenerationDependenciesAreAcyclic(plan: PlanGenerationOutput): void {
  if (hasPlanGenerationDependencyCycle(plan)) {
    throw new PlanGenerationDependencyCycleError()
  }
}
