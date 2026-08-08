import { z } from 'zod'

export const entityIdSchema = z.uuid()

export const isoDateTimeSchema = z.iso.datetime({ offset: true })

export const isoDateSchema = z.iso.date()
