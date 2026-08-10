export interface CurrentActor {
  userId: string
  timezone: string
}

export const CURRENT_ACTOR = Symbol('CURRENT_ACTOR')
