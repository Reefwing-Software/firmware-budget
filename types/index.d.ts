// One measurement of the ELF, taken after a build.
export type Sample = {
  // Build number within the session, from 1
  n: number
  // The XIP image plus the .data load image: what sits in flash
  flash: number
  // Every section the linker placed at a RAM address
  ram: number
  // The build command, trimmed to a short label
  label: string
}

declare module 'claude-code' {
  interface PluginState {
    'firmware-budget': {
      // Every sample this session, oldest first
      samples: Sample[]
      // The last size run that failed, or null
      fault: string | null
    }
  }
}
