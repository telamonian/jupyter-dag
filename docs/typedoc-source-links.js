/*
 * TypeDoc plugin: turn cited dependency sources into GitHub permalinks.
 *
 * The TSDoc comments cite installed sources as `@scope/pkg/src/file.ts:line` (TypeScript that the
 * npm packages ship, so every citation can be checked against node_modules). When the docs are
 * rendered, each such citation becomes a link to the same file and line at the release tag of the
 * installed version, read from node_modules at build time; nothing is pinned by hand.
 *
 * Follows the renderer-hook pattern of JupyterLab core's docs/typedoc-customizations.js.
 */
const fs = require('fs');
const path = require('path');
const { PageEvent } = require('typedoc');

const ROOT = path.resolve(__dirname, '..');

/** The version of an installed package, or null if it is not installed. */
function installedVersion(scope, pkg) {
  try {
    const file = path.join(ROOT, 'node_modules', scope, pkg, 'package.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).version;
  } catch {
    return null;
  }
}

/** Where a scope's sources live on GitHub, and the tag that corresponds to an installed version. */
const REPOS = {
  '@jupyterlab': {
    // One release tag for the whole monorepo; every @jupyterlab/* package comes from that release.
    url: (pkg, file, line) => {
      const lab = installedVersion('@jupyterlab', 'application');
      return lab && `https://github.com/jupyterlab/jupyterlab/blob/v${lab}/packages/${pkg}/src/${file}#L${line}`;
    }
  },
  '@lumino': {
    url: (pkg, file, line) => {
      const v = installedVersion('@lumino', pkg);
      return v && `https://github.com/jupyterlab/lumino/blob/@lumino/${pkg}@${v}/packages/${pkg}/src/${file}#L${line}`;
    }
  },
  '@jupyter': {
    url: (pkg, file, line) => {
      if (pkg !== 'ydoc') {
        return null;
      }
      const v = installedVersion('@jupyter', 'ydoc');
      return v && `https://github.com/jupyter-server/jupyter_ydoc/blob/v${v}/javascript/src/${file}#L${line}`;
    }
  }
};

// <code>@scope/pkg/src/path/file.ts:123</code> (or :123-130) as TypeDoc renders an inline code span.
const CITATION = /<code>(@[a-z-]+)\/([a-z-]+)\/src\/([\w./-]+?):(\d+)(?:-(\d+))?<\/code>/g;

/**
 * @param {import('typedoc').Application} app
 */
exports.load = function (app) {
  app.renderer.on(PageEvent.END, page => {
    if (typeof page.contents !== 'string') {
      return;
    }
    page.contents = page.contents.replace(CITATION, (match, scope, pkg, file, line, end) => {
      const repo = REPOS[scope];
      let url = repo && repo.url(pkg, file, line);
      if (!url) {
        return match;
      }
      if (end) {
        url += `-L${end}`;
      }
      return `<a href="${url}" target="_blank" rel="noopener">${match}</a>`;
    });
  });
};
