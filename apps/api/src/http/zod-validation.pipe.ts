import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common'
import type { z } from 'zod'

@Injectable()
export class ZodValidationPipe<TSchema extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): z.output<TSchema> {
    const result = this.schema.safeParse(value)

    if (!result.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }

    return result.data
  }
}
