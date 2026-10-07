import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every package and app is its own test project
    projects: ['packages/*', 'apps/*'],
    // Packages without tests yet must not fail the run
    passWithNoTests: true,
  },
});
