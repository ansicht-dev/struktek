import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 10000,
  },
  resolve: {
    // Unit tests never launch a real extension host; `vscode` resolves to a
    // hand-written stub so host modules are importable outside VS Code.
    alias: { vscode: new URL('./src/__tests__/__mocks__/vscode.ts', import.meta.url).pathname },
  },
});
