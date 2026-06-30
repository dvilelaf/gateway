export const MARLIN_RUNTIME_PROFILE_ENV = 'MARLIN_RUNTIME_PROFILE';
export const MARLIN_RUNTIME_PROFILE = 'marlin';

export function isMarlinRuntimeProfile(): boolean {
  return (process.env[MARLIN_RUNTIME_PROFILE_ENV] ?? '').trim().toLowerCase() === MARLIN_RUNTIME_PROFILE;
}
