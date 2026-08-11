import { z } from 'zod'

export const entityIdSchema = z.uuid()

export const isoDateTimeSchema = z.iso.datetime({ offset: true })

export const isoDateSchema = z.iso.date()

export const MODEL_CATALOG_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,99}$/

export const modelCatalogIdSchema = z.string().regex(MODEL_CATALOG_ID_PATTERN)
