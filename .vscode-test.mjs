import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  // The picker uses the `browser` API proposal; stable VS Code needs this flag for it.
  launchArgs: ['--enable-proposed-api=iyansr.paddock'],
});
