/**
 * Entry point of the `@telamonian/jupyter-dag` labextension.
 *
 * JupyterLab loads a federated extension's default export, which may be one plugin or an array
 * of plugins; this package exports the two in `dag/plugin.ts`. The named exports re-export
 * `dag/tokens.ts`, so `import { IDagTracker } from '@telamonian/jupyter-dag'` works. The other
 * `dag/*` modules are internal, but documented in the same detail: `jlpm docs` renders them and
 * `jlpm docs:check` verifies their comments.
 *
 * Citations of the form `@jupyterlab/services/src/kernel/default.ts:359` point into the TypeScript
 * sources shipped inside the installed packages under `node_modules` (JupyterLab 4.6.3, Lumino 2.x),
 * so every one can be checked with `sed -n`; the rendered docs link them to the same lines at the
 * release tag on GitHub.
 *
 * @packageDocumentation
 */
import { dagPlugins } from './dag/plugin';

export default dagPlugins;
export * from './dag/tokens';
