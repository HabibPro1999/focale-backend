/** Minimal client state needed by module policy checks; no runtime validation. */
export interface ClientModuleGate {
  active: boolean;
  enabledModules: string[] | null;
}
