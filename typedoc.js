/*
 * TypeDoc configuration, after JupyterLab core's typedoc.js.
 * `jlpm docs` renders docs/api; `jlpm docs:check` only runs the validation.
 */
const jupyterlabPackages = [
  'application',
  'apputils',
  'cells',
  'codeeditor',
  'coreutils',
  'docmanager',
  'docregistry',
  'notebook',
  'observables',
  'outputarea',
  'rendermime',
  'services',
  'settingregistry',
  'translation',
  'ui-components'
];

const jupyterlabLinks = Object.fromEntries(
  jupyterlabPackages.map(p => [
    `@jupyterlab/${p}`,
    { '*': `https://jupyterlab.readthedocs.io/en/latest/api/modules/${p}.html` }
  ])
);

module.exports = {
  name: '@telamonian/jupyter-dag',
  entryPoints: ['src/index.ts', 'src/dag'],
  entryPointStrategy: 'expand',
  out: 'docs/api',
  readme: 'README.md',
  includeVersion: true,
  excludePrivate: true,
  // Every export in the entry points must carry a doc comment; links must resolve.
  validation: {
    notExported: true,
    invalidLink: true,
    notDocumented: true
  },
  requiredToBeDocumented: [
    'Class',
    'Interface',
    'Function',
    'Method',
    'Property',
    'Accessor',
    'TypeAlias',
    'Variable',
    'Enum',
    'EnumMember'
  ],
  treatValidationWarningsAsErrors: process.env.CI === 'true',
  sourceLinkTemplate: 'https://github.com/telamonian/jupyter-dag/blob/{gitRevision}/{path}#L{line}',
  externalSymbolLinkMappings: {
    ...jupyterlabLinks,
    '@jupyter/ydoc': {
      '*': 'https://jupyter-ydoc.readthedocs.io/en/latest/api/'
    },
    '@lumino/coreutils': {
      '*': 'https://lumino.readthedocs.io/en/latest/api/modules/coreutils.html'
    },
    '@lumino/disposable': {
      '*': 'https://lumino.readthedocs.io/en/latest/api/modules/disposable.html'
    },
    '@lumino/signaling': {
      '*': 'https://lumino.readthedocs.io/en/latest/api/modules/signaling.html'
    },
    '@lumino/widgets': {
      '*': 'https://lumino.readthedocs.io/en/latest/api/modules/widgets.html'
    },
    '@lumino/messaging': {
      '*': 'https://lumino.readthedocs.io/en/latest/api/modules/messaging.html'
    },
    '@lumino/algorithm': {
      '*': 'https://lumino.readthedocs.io/en/latest/api/modules/algorithm.html'
    },
    '@xyflow/react': { '*': 'https://reactflow.dev/api-reference' },
    '@dagrejs/dagre': { '*': 'https://github.com/dagrejs/dagre/wiki' }
  },
  plugin: ['typedoc-plugin-mdn-links', './docs/typedoc-source-links.js']
};
