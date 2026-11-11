import type { CourseGenerationRequest } from '../../src/index.js'
import type { CourseLearningPackage } from '@knowledgeops/contracts'

export const validCourseGenerationRequest = {
  generationRunId: '8fb289a2-0376-43f2-bbb2-ff339257f673',
  model: {
    catalogId: 'openai-primary',
    provider: 'openai',
    modelName: 'test-model',
    promptVersion: 'course-generation-v1',
    outputSchemaVersion: 'course-generation-output-v1',
  },
  goal: {
    title: '准备前端实习面试',
    currentLevel: '熟悉 Vue 3，对浏览器调度缺少实际经验。',
  },
  course: {
    taskId: '6fb289a2-0376-43f2-bbb2-ff339257f673',
    title: '理解浏览器事件循环',
    description: '通过页面更新情景理解任务、微任务和渲染顺序。',
    estimatedMinutes: 60,
    knowledgePoints: [
      {
        id: 'event-loop',
        title: '事件循环',
        description: '理解任务、微任务与渲染之间的调度顺序。',
      },
    ],
  },
  review: [],
} as const satisfies CourseGenerationRequest

export const validCourseLearningPackage = {
  sections: [
    {
      id: 'task-basics',
      title: '任务与调用栈',
      explanation: '浏览器会把一次 JavaScript 执行放到调用栈上，当前任务完成后才继续处理后续工作。',
      scenario: '用户点击按钮后，同一个事件处理器需要更新状态并计算结果。',
      example: 'console.log("start"); setTimeout(() => console.log("later"), 0);',
      misconception: 'setTimeout 的延迟为零不代表回调会立即插入当前调用栈。',
    },
    {
      id: 'microtask-order',
      title: '微任务的执行时机',
      explanation: '当前任务结束且调用栈清空后，浏览器会依次清空微任务队列，再进入后续调度。',
      scenario: 'Vue 批量更新希望把同一轮多次状态修改合并为一次 DOM 更新。',
      example: 'Promise.resolve().then(() => console.log("microtask"));',
      misconception: '微任务并不是与 setTimeout 回调同属一个先进先出队列。',
    },
    {
      id: 'rendering-boundary',
      title: '渲染与下一次任务',
      explanation: '浏览器根据调度机会进行渲染，不能把每次微任务执行都理解成一次完整页面绘制。',
      scenario: '连续修改多个响应式字段时，用户只应看到最终稳定界面。',
      example: '修改状态后等待 nextTick，可以读取更新后的 DOM。',
      misconception: 'nextTick 保证的是 Vue 更新队列已刷新，不是保证屏幕已经完成绘制。',
    },
  ],
  exercises: {
    multipleChoice: ['one', 'two', 'three', 'four'].map((suffix, index) => ({
      id: `choice-${suffix}`,
      knowledgePointId: 'event-loop',
      prompt: `关于事件循环的场景判断 ${index + 1}`,
      options: [
        { id: 'a', text: '当前调用栈先执行完成' },
        { id: 'b', text: 'setTimeout 总是先执行' },
        { id: 'c', text: '每次微任务都必然绘制一次' },
        { id: 'd', text: 'Promise 会绕过队列' },
      ],
      correctOptionId: 'a',
      explanation: 'JavaScript 当前调用栈完成后才进入后续队列调度。',
    })),
    followUp: {
      id: 'follow-up',
      knowledgePointIds: ['event-loop'],
      prompt: '结合一次 Vue 状态更新，解释 nextTick 与 setTimeout 回调的先后依据。',
      rubric: ['说明当前任务先完成', '说明微任务队列清空时机', '区分 Vue DOM 更新与浏览器绘制'],
    },
  },
} as const satisfies CourseLearningPackage
