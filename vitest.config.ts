import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/**/*.test.ts', 'ponte/controllo/src/**/*.test.ts', 'esterna/src/**/*.test.ts'], environment: 'node' }
})
