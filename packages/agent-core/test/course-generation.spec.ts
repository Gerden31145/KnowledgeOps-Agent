import { describe, expect, it } from 'vitest'

import {
  InvalidCourseGenerationOutputError,
  generateCourseCandidate,
  type CourseGenerationPort,
} from '../src/index.js'
import {
  validCourseGenerationRequest,
  validCourseLearningPackage,
} from './fixtures/course-generation.js'

describe('course learning package generation', () => {
  it('generates course sections and the complete exercise set through one boundary', async () => {
    const port: CourseGenerationPort = { generate: async () => validCourseLearningPackage }
    await expect(generateCourseCandidate(port, validCourseGenerationRequest)).resolves.toEqual(
      validCourseLearningPackage,
    )
  })

  it('rejects exercises that reference knowledge outside the course outline', async () => {
    const invalid = structuredClone(validCourseLearningPackage)
    invalid.exercises.multipleChoice[0]!.knowledgePointId = 'unknown-point'
    await expect(
      generateCourseCandidate({ generate: async () => invalid }, validCourseGenerationRequest),
    ).rejects.toBeInstanceOf(InvalidCourseGenerationOutputError)
  })

  it('rejects an invalid correct option or an incomplete exercise set', async () => {
    const wrongOption = structuredClone(validCourseLearningPackage)
    wrongOption.exercises.multipleChoice[0]!.correctOptionId = 'missing'
    const incomplete = structuredClone(validCourseLearningPackage)
    incomplete.exercises.multipleChoice.pop()
    const port: CourseGenerationPort = {
      generate: async () => wrongOption,
    }
    await expect(
      generateCourseCandidate(port, validCourseGenerationRequest),
    ).rejects.toBeInstanceOf(InvalidCourseGenerationOutputError)
    await expect(
      generateCourseCandidate({ generate: async () => incomplete }, validCourseGenerationRequest),
    ).rejects.toBeInstanceOf(InvalidCourseGenerationOutputError)
  })
})
