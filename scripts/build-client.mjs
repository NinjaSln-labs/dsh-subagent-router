/**
 * Build the browser half as a ModuleLoader factory bundle.
 *
 * Plain `tsc` emits ESM that the web shell cannot execute. The client-modules
 * contract requires the artifact to register via:
 *   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
 * Platform modules (react, cordis, …) stay external and resolve through the
 * shell's frozen require table — same shape as in-tree `clientBundle()` and
 * dsh-context-compass's client build.
 */
import * as esbuild from 'esbuild'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { name: id } = require('../package.json')

/** Specifiers answered by the shell module table (must not be inlined). */
const EXTERNAL = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-renderer/client',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-ui-settings-plugins/client',
  // 0.2.0 的设置页设计系统。必须 external：这些组件要与宿主共享同一套 React
  // 上下文与 CSS token，内联一份会得到第二套样式（正是本次重构要消灭的问题）。
  '@deepseek-ai/dsh-client-ui-primitives',
]

await esbuild.build({
  absWorkingDir: new URL('..', import.meta.url).pathname,
  entryPoints: ['src/client.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  logLevel: 'info',
  external: EXTERNAL,
  banner: {
    js: [
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      'var module = { exports: {} }; var exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: 'return module.exports; } });',
  },
})

console.log(`built lib/client.js (__ModuleLoader__ id=${id})`)
