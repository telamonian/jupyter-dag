/**
 * Entry point of the `@telamonian/jupyter-dag` labextension.
 *
 * JupyterLab loads a federated extension's default export, which may be one plugin or an array
 * of plugins; this package exports the two in `dag/plugin.ts`. The named exports re-export
 * `dag/tokens.ts`, the ids, tokens and shapes another extension can depend on, so
 * `import { IDagTracker } from '@telamonian/jupyter-dag'` works without importing the view code.
 * The other `dag/*` modules are internal, but documented in the same detail: `jlpm docs` renders
 * them and `jlpm docs:check` verifies their comments.
 *
 * @packageDocumentation
 */
import { dagPlugins } from './dag/plugin';

export default dagPlugins;
export * from './dag/tokens';
