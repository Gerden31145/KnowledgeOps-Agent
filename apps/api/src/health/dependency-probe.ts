export interface DependencyProbe {
  check(): Promise<void>
  close(): Promise<void>
}

export interface ReadinessProbes {
  postgresql: DependencyProbe
  redis: DependencyProbe
}
