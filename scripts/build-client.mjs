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
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-ui-settings-plugins/client',
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
