# jupyter_dag

[![Github Actions Status](https://github.com/telamonian/jupyter-dag/workflows/Build/badge.svg)](https://github.com/telamonian/jupyter-dag/actions/workflows/build.yml)
[![Binder](https://mybinder.org/badge_logo.svg)](https://mybinder.org/v2/gh/telamonian/jupyter-dag/main?urlpath=lab)

Organize notebook cells into DAGs and run them reactively in JupyterLab

This extension is composed of a Python package named `jupyter_dag`
for the server extension and a NPM package named `@telamonian/jupyter-dag`
for the frontend extension.

## Requirements

- JupyterLab >= 4.0.0

## Install

To install the extension, execute:

```bash
pip install jupyter_dag
```

## Uninstall

To remove the extension, execute:

```bash
pip uninstall jupyter_dag
```

## Troubleshoot

If you are seeing the frontend extension, but it is not working, check
that the server extension is enabled:

```bash
jupyter server extension list
```

If the server extension is installed and enabled, but you are not seeing
the frontend extension, check the frontend extension is installed:

```bash
jupyter labextension list
```

## Contributing

If you would like to contribute to this extension, please refer to the [Contributing Guide](CONTRIBUTING.md).

## AI Coding Assistant Support

This project includes an `AGENTS.md` file with coding standards and best practices for JupyterLab extension development. The file follows the [AGENTS.md standard](https://agents.md) for cross-tool compatibility.

### Compatible AI Tools

`AGENTS.md` works with AI coding assistants that support the standard, including Cursor, GitHub Copilot, Windsurf, Aider, and others. For a current list of compatible tools, see [the AGENTS.md standard](https://agents.md).

Other conventions you might encounter:

- `.cursorrules` - Cursor's YAML/JSON format (Cursor also supports AGENTS.md natively)
- `CONVENTIONS.md` / `CONTRIBUTING.md` - For CodeConventions.ai and GitHub bots
- Project-specific rules in JetBrains AI Assistant settings

All tool-specific files should be symlinks to `AGENTS.md` as the single source of truth.

### What's Included

The `AGENTS.md` file provides guidance on:

- Code quality rules and file-scoped validation commands
- Naming conventions for packages, plugins, and files
- Coding standards (TypeScript, Python)
- Development workflow and debugging
- Backend-frontend integration patterns (`APIHandler`, `requestAPI()`, routing)
- Common pitfalls and how to avoid them

### Customization

You can edit `AGENTS.md` to add project-specific conventions or adjust guidelines to match your team's practices. The file uses plain Markdown with Do/Don't patterns and references to actual project files.

**Note**: `AGENTS.md` is living documentation. Update it when you change conventions, add dependencies, or discover new patterns. Include `AGENTS.md` updates in commits that modify workflows or coding standards.

## Kernel

The DAG view talks to a kernel that understands `analyze_request`, `namespace_delete` and
`namespace_delta` (advertised through `supported_features`). Two ways to get one:

- the kernelspec `Python 3 (jupyter-dag)` installed with the wheel (`jupyter kernelspec list`);
- `%load_ext jupyter_dag` inside a stock Python kernel, which adds the handlers and comm target to the
  running kernel; the frontend uses the comm transport until the kernel is restarted.

Deployments that restrict `c.MappingKernelManager.allowed_message_types` must include
`analyze_request`.

## Attribution

The DAG canvas is built on [React Flow](https://reactflow.dev) (MIT). Parts of the kernel-side
comm dispatch and kernelspec installer follow [ipyflow](https://github.com/ipyflow/ipyflow)
(BSD-3-Clause, Stephen Macke); see the attribution comments in `jupyter_dag/kernel/`.
