# JupyterLab Extension Development

This guide provides coding standards and best practices for developing JupyterLab extensions. Follow these rules to align with community standards and keep your extension maintainable.

**Extension type**: frontend-and-server

## External Documentation and Resources

### PRIORITY RESOURCE USAGE

**When you encounter uncertainty, incomplete information, or need implementation examples, you MUST consult these external resources FIRST before attempting to implement features.**

Use your available tools (web search, documentation search) to access and retrieve content from these resources when:

- You're unsure about API usage, method signatures, or interface requirements
- You need to verify the correct approach for a feature or pattern
- You're looking for existing implementation examples or best practices
- You're debugging unexpected behavior and need official documentation
- You're implementing a feature that likely exists in core JupyterLab or other extensions

### Required External Resources

**These resources are PRIORITY references. Always check them when you need external information:**

1. **JupyterLab Extension Developer Guide**
   - URL: https://jupyterlab.readthedocs.io/en/stable/extension/extension_dev.html
   - Use for: Extension patterns, architecture overview, development workflow, and best practices
   - **Action**: Use web search or documentation tools to retrieve specific sections when needed

2. **JupyterLab API Reference (Frontend)**
   - URL: https://jupyterlab.readthedocs.io/en/latest/api/index.html
   - Use for: Complete API reference for all JupyterLab frontend packages, interfaces, classes, and methods
   - **Action**: Search for specific APIs when you need method signatures, interface definitions, or class documentation. For example, search "JupyterLab IRenderMime.IRenderer" or "JupyterLab ICommandPalette"

3. **JupyterLab Extension Examples Repository**
   - URL: https://github.com/jupyterlab/extension-examples
   - Use for: Working code examples, implementation patterns, complete working extensions
   - **Action**: Search this repository for similar features before implementing from scratch

4. **JupyterLab Core Repository**
   - URL: https://github.com/jupyterlab/jupyterlab
   - Use for: Reference implementations in `packages/` directory - all core packages are extensions themselves
   - **Action**: When implementing complex features, search this repo for how core extensions solve similar problems

5. **Jupyter Server API Documentation**
   - URL: https://jupyter-server.readthedocs.io/
   - Use for: Server-side API handlers, route setup, backend integration patterns
   - **Action**: Consult when working on backend routes or server extension configuration

6. **Project-Specific Documentation**
   - Locations: `README.md`, `RELEASE.md` in project root; check for `docs/` directory
   - Use for: Project requirements, specific configuration, custom conventions
   - **Action**: Read these files at the start of work and reference when making architectural decisions

### When to Use These Resources

**ALWAYS consult external documentation when:**

- ❗ You're about to implement a feature without knowing if there's an established pattern
- ❗ An API call or method isn't working as expected
- ❗ You need to understand the correct lifecycle methods or hooks
- ❗ You're uncertain about type definitions or interfaces
- ❗ You're implementing something that seems like it should be a common pattern

**HOW to access these resources:**

- 🔍 Use web search tools with specific queries like: "JupyterLab IRenderMime.IRenderer interface documentation"
- 🔍 Search GitHub repositories for code examples: "JupyterLab extension examples widget"
- 🔍 Retrieve documentation pages to read API specifications and usage guidelines
- 🔍 Look for working code in the extension-examples repository before writing custom implementations

**Remember:** These resources contain the authoritative information. Don't guess at API usage - look it up!

## Code Quality Rules

### Logging and Debugging

**❌ Don't**: Use `console.log()`
**✅ Do**: Use structured logging or user-facing notifications

```typescript
// In TypeScript files like src/index.ts
import { INotification } from '@jupyterlab/apputils';
app.commands.notifyCommandChanged();
```

**✅ Do**: Use `console.error()` to log low-level error details that should not be presented to users in the UI
**✅ Do**: Use `console.warn()` to log non-optimal conditions, e.g. an unexpected response from an external API that's been successfully handled.

### Type Safety

**✅ Do**: Define explicit interfaces (see example patterns in `src/index.ts`)

```typescript
interface PluginConfig {
  enabled: boolean;
  apiEndpoint: string;
}
```

**❌ Don't**: Use the `any` type in TypeScript files
**✅ Do**: Prefer typeguards over type casts

### File-Scoped Validation

After editing TypeScript files, run:

```bash
npx tsc --noEmit src/index.ts  # Check single file
npx tsc --noEmit               # Check all files
```

After editing Python files (like `jupyter_dag/routes.py`):

```bash
python -m py_compile jupyter_dag/__init__.py  # Check single file for syntax errors
```

## Coding Standards

### Naming Conventions

**Python** (in `jupyter_dag/*.py` files):

- **✅ Do**: Use PEP 8 style with 4-space indentation
  - Classes: `DataProcessor`, `UserDataRouteHandler`
  - Functions/methods: `setup_route_handlers()`, `process_request()`
  - Private: `_internal_method()`
- **❌ Don't**: Use camelCase for Python or mix styles

**TypeScript/JavaScript** (in `src/*.ts` files):

- **✅ Do**: Use consistent casing
  - Classes/interfaces: `MyPanelWidget`, `PluginConfig`
  - Functions/variables: `activatePlugin()`, `buttonCount`
  - Constants: `PLUGIN_ID`, `COMMAND_ID`
- **✅ Do**: Use 2-space indentation (Prettier default)
- **❌ Don't**: Use lowercase_snake_case or inconsistent formatting

### Documentation

**✅ Do**: Add JSDoc for TypeScript and docstrings for Python

```typescript
/**
 * Activates the extension plugin.
 * @param app - JupyterLab application instance
 */
function activate(app: JupyterFrontEnd): void {}
```

**❌ Don't**: Leave complex logic undocumented or use vague names like `MyRouteHandler` — prefer `DataUploadRouteHandler`

### Code Organization

**✅ Do**: Keep backend and frontend logic separate

- Backend processing in `jupyter_dag/routes.py`
- Frontend calls in `src/request.ts` using `requestAPI()`

**❌ Don't**: Duplicate business logic across TypeScript and Python

**✅ Do**: Implement features completely or not at all. Notify the prompter if you're unable to completely implement a feature.

**❌ Don't**: Leave TODO comments or dead code in committed files

## Project Structure and Naming

### Package Naming

**Python package** (directory name and imports):

- **✅ Do**: `jupyter_dag/` with underscores, all lowercase
- **❌ Don't**: Use dashes in any Python file or directory names

**PyPI distribution name** (in `pyproject.toml`):

- **✅ Do**: Use dashes instead of underscores, like `jupyterlab-myext`
- **✅ Do**: Match it to the npm package name for consistency

**NPM package** (in `package.json`):

- **✅ Do**: Use lowercase with dashes: `"jupyterlab-myext"` or scoped `"@org/myext"`
- **❌ Don't**: Mix naming styles between package.json and pyproject.toml

### Plugin and Command IDs

**✅ Do**: Define plugin ID in `src/index.ts`:

```typescript
const PLUGIN_ID = 'jupyter_dag:plugin';
```

**✅ Do**: For extensions with multiple commands, create a `src/commands.ts` module to centralize command definitions:

```typescript
// src/commands.ts
import { JupyterFrontEnd } from '@jupyterlab/application';
import { ReadonlyPartialJSONObject } from '@lumino/coreutils';

// Command IDs
export namespace CommandIDs {
  export const openPanel = 'jupyter_dag:open-panel';
  export const refreshData = 'jupyter_dag:refresh-data';
}

// Command argument types
export namespace CommandArguments {
  export interface IOpenPanel {
    filePath?: string;
  }

  export interface IRefreshData {
    force?: boolean;
  }
}

/**
 * Register all commands with the application command registry.
 * Call this function in your plugin's activate function.
 */
export function registerCommands(app: JupyterFrontEnd): void {
  // Register the openPanel command
  app.commands.addCommand(CommandIDs.openPanel, {
    label: 'Open Panel',
    caption: 'Open the extension panel',
    execute: (args: ReadonlyPartialJSONObject) => {
      const typedArgs = args as CommandArguments.IOpenPanel;
      // Implementation using typedArgs.filePath
    }
  });

  // Register the refreshData command
  app.commands.addCommand(CommandIDs.refreshData, {
    label: 'Refresh Data',
    execute: (args: ReadonlyPartialJSONObject) => {
      const typedArgs = args as CommandArguments.IRefreshData;
      // Implementation using typedArgs.force
    }
  });
}
```

Then in `src/index.ts`:

```typescript
import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { registerCommands, CommandIDs, CommandArguments } from './commands';

const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyter_dag:plugin',
  autoStart: true,
  activate: (app: JupyterFrontEnd) => {
    // Register all commands with JupyterLab's command registry
    registerCommands(app);

    // Commands are now registered and can be executed anywhere:
    // - From the command palette
    // - From menus
    // - Programmatically via app.commands.execute()

    // ... rest of activation (e.g., add to palette, create widgets, etc.)
  }
};

export default plugin;
```

**Executing commands with typed arguments:**

```typescript
import { CommandIDs, CommandArguments } from './commands';

// Execute with typed arguments
await app.commands.execute(CommandIDs.openPanel, {
  filePath: '/path/to/file'
} as CommandArguments.IOpenPanel);

// Execute without arguments
await app.commands.execute(CommandIDs.refreshData);
```

**Notes:**

- Accept `ReadonlyPartialJSONObject` in the execute function signature (required by Lumino)
- Cast to your typed interface inside the function for type safety
- Use namespaces (`CommandIDs`, `CommandArguments`) to organize related constants and types
- This pattern matches how popular extensions like `jupyterlab-git` handle commands

**✅ Do**: For simple extensions with 1-2 commands, you can define them directly in `src/index.ts`

**❌ Don't**: Use generic IDs like `'mycommand'` or mix casing styles

### File Organization

**✅ Do**: Organize related files into directories and name by their purpose

- Widget components: `src/widgets/DataPanel.tsx` (class `DataPanel`)
- Command definitions (for multiple commands): `src/commands.ts` with `COMMANDS` mapping
- API utilities: `src/api.ts` (not `src/utils.ts`)
- Backend routes: `jupyter_dag/routes.py` (class `DataRouteHandler`)
- Frontend logic: `src/` directory
- Python package: `jupyter_dag/` directory

**❌ Don't**: Create catch-all files or directories like `utils.ts` or `helpers.py` or `handlers.py` — partition by feature instead

## Backend–Frontend Integration

### Integration Workflow (Critical!)

When connecting frontend and backend, **ALWAYS follow this order**:

1. **Read the backend first** — Check `jupyter_dag/routes.py` to understand the existing API contract
2. **Write frontend to match** — Create TypeScript interfaces in `src/api.ts` that match backend responses exactly
3. **Or modify backend intentionally** — If changing the backend, update it first, then write matching frontend code

**Why this matters**: Writing frontend code based on assumptions leads to field name mismatches (e.g., expecting `message` when backend returns `data`), causing empty widgets and debugging cycles. Always verify the actual backend response format first.

### Backend Routes

Create RESTful endpoints in `jupyter_dag/routes.py`:

**✅ Do**: Extend `APIHandler` from `jupyter_server.base.handlers`

```python
from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join
import tornado

class DataRouteHandler(APIHandler):
    @tornado.web.authenticated
    def get(self):
        """Handle GET requests."""
        result = {"status": "success", "data": "Hello"}
        self.finish(result)

    @tornado.web.authenticated
    def post(self):
        """Handle POST requests."""
        body = self.get_json_body()
        # Process body...
        self.finish({"status": "success"})

def setup_route_handlers(web_app):
    base_url = web_app.settings.get("base_url", "/")
    data_route = url_path_join(base_url, "jupyter_dag", "data")
    web_app.add_handlers(r".*$", [(data_route, DataRouteHandler)])
```

**✅ Do**: Include error handling in route handlers

**✅ Do**: Decorate **every** verb method (`head`, `get`, `post`, `patch`, `put`, `delete`, `options`) with `@tornado.web.authenticated`; endpoints which are meant to be public need an explicit `@allow_unauthenticated` (or `@ws_authenticated` for websockets) decorator from `jupyter_server.auth.decorator` instead. After adding or editing a handler, verify with:

```bash
python .github/scripts/check_auth.py
```

**✅ Do**: Remember that authentication is not authorization — an authenticated user is not necessarily allowed to touch the resource. For handlers exposing or modifying user data, also set `auth_resource` (e.g. `auth_resource = "contents"`) and add `@authorized` from `jupyter_server.auth` under `@tornado.web.authenticated`. The check above cannot detect a missing `@authorized`.

**❌ Don't**:

- Hardcode URL paths — always use `url_path_join()`
- Use plain `tornado.web.RequestHandler` — instead, use `APIHandler` from `jupyter_server.base.handlers`
- Leave any verb method undecorated — an unauthenticated endpoint exposes the user's server

### Frontend API Calls

**✅ Do**: Call backend endpoints from typed API functions in `src/api.ts` (not directly in widgets):

```ts
import { ServerConnection } from '@jupyterlab/services';
import { requestAPI } from './request';

interface DataResponse {
  status: 'success' | 'error';
  data: string;
}

export async function fetchData(
  serverSettings: ServerConnection.ISettings
): Promise<string> {
  try {
    const response = await requestAPI<DataResponse>('data', serverSettings, {
      method: 'GET'
    });
    if (response.status === 'error') {
      throw new Error('Server returned error');
    }
    return response.data;
  } catch (err) {
    // Extract detailed error information from ResponseError
    if (err instanceof ServerConnection.ResponseError) {
      const status = err.response.status;
      let detail = err.message;

      // Truncate HTML responses for cleaner error messages
      if (
        typeof detail === 'string' &&
        (detail.includes('<!DOCTYPE') || detail.includes('<html'))
      ) {
        detail = `HTML error page (${detail.substring(0, 100)}...)`;
      }

      throw new Error(`API request failed (${status}): ${detail}`);
    }

    const msg = err instanceof Error ? err.message : 'Unknown error';
    throw new Error(`API request failed: ${msg}`);
  }
}
```

**✅ Do**:

- Always wrap API calls in try-catch blocks with proper error handling
- Check for `ServerConnection.ResponseError` to extract HTTP status codes and response details
- Handle HTML error responses gracefully by truncating them (they're often unhelpful error pages)
- Include response status codes in error messages for better debugging
- Use matching response types between Python and TypeScript
- Create typed API wrapper functions in `src/api.ts` instead of calling `requestAPI()` directly from widgets

### API Sync and Naming

**✅ Do**: Keep backend and frontend in sync

- Match JSON keys: `{"result": ...}` in Python → `response.result` in TypeScript
- Update TypeScript interfaces when changing Python responses
- Define matching endpoint path strings (e.g., `"hello"`, `"get-data"`) in both `jupyter_dag/routes.py` and `src/api.ts` to ensure routes sync between backend and frontend

**❌ Don't**:

- Create unused routes or orphaned API calls
- Use inconsistent field naming across languages

## Development Workflow

### Environment Activation (CRITICAL)

**Before ANY command**, ensure you're in the correct environment:

```bash
# For conda/mamba/micromamba (replace `conda` with `mamba` or `micromamba` depending on the prompter's preferred tool):
conda activate <environment-name>

# For venv:
source <path-to-venv>/bin/activate  # On macOS/Linux
<path-to-venv>\Scripts\activate.bat # On Windows
```

**All `jlpm`, `pip`, and `jupyter` commands MUST run within the activated environment.**

**Symptoms of running outside the environment:**

- `jlpm: command not found`
- Extension not appearing after build
- `jupyter: command not found`

**✅ Do**: Always activate your environment first
**❌ Don't**: Run commands in your base/system environment

---

### Complete Development Workflow Checklist

**When implementing a new feature from scratch, follow this complete sequence:**

1. **Activate environment** (see above — required first!)
2. **Write the code** (TypeScript in `src/`, styles in `style/`, Python in `jupyter_dag/`)
3. **Install dependencies** (if you added any to `package.json`):
   ```bash
   jlpm install
   ```
4. **Build the extension**:
   ```bash
   jlpm build
   ```
5. **Install the extension** (REQUIRED for JupyterLab to recognize it):
   ```bash
   pip install -e .
   jupyter-builder develop . --overwrite
   jupyter server extension enable jupyter_dag
   ```
6. **Verify installation**:
   ```bash
   jupyter labextension list  # Should show your extension as "enabled" and "OK"
   jupyter server extension list  # Should show backend extension
   ```
7. **Start JupyterLab**:
   ```bash
   jupyter lab
   ```
8. **Test the feature** in your browser

**Critical: Steps 5-7 are REQUIRED after building. Building alone is not enough!**

---

### Understanding Build vs Install

Many issues arise from confusing these two steps:

#### `jlpm build` — Compiles the Extension. Do this every time you change TypeScript code.

- **What it does**: Compiles TypeScript → JavaScript, bundles the extension
- **Output**: Creates files in `lib/` and `jupyter_dag/labextension/`
- **What it does NOT do**: Register the extension with JupyterLab

#### `pip install -e .` + `jupyter-builder develop .` — Registers the Extension. Do this once as a setup step.

- **What it does**: Tells JupyterLab where to find your extension
- **Output**: Creates symlinks so changes are reflected
- **Note**: Also installs the Python package in editable mode
- **Result**: Extension appears in JupyterLab

**You need BOTH steps!** Building prepares the code; installing registers it with JupyterLab.

**Common mistake**: Running only `jlpm build` and expecting the extension to appear. It won't show up until you also run the installation commands.

---

### Initial Setup (run once)

```bash
pip install -e ".[dev,test]"
jupyter-builder develop . --overwrite
jupyter server extension enable jupyter_dag
```

### Iterative Development

**Development with auto-rebuild** (recommended):

```bash
jlpm run watch                      # Auto-rebuild on file changes (keep running)
# In another terminal:
jupyter lab
```

**After editing TypeScript** (files in `src/`):

- If using `jlpm run watch`: Just **refresh your browser** (Cmd+R / Ctrl+R)
- If not using watch: Run `jlpm build`, then **refresh your browser**

**Quick TypeScript validation** (optional, for fast feedback):

```bash
npx tsc --noEmit src/index.ts       # Check single file
```

**After editing Python** (files in `jupyter_dag/`):

- **Restart the JupyterLab server** (Ctrl+C in terminal, then `jupyter lab` again)
- No rebuild needed!
- Only run `pip install -e .` if you changed package structure (renamed package directory, or modified entry points in `pyproject.toml`)

**Memory aid**: "What did you change? Restart that!"

- Changed **JavaScript** → Build (or auto-builds with watch) → **Refresh browser**
- Changed **Python** → **Restart JupyterLab server** (no build needed)

### Debugging and Diagnostics

```bash
jupyter labextension list           # Check if extension is installed
jupyter server extension list        # Check backend extension
jlpm run lint                # Lint frontend code
```

**Browser console** (ask user to check):

- Request user to open browser console (F12 or Cmd+Option+I)
- Ask user to report any JavaScript errors
- Ask user to check for failed network requests to backend endpoints
- Ask user if the extension appears to be loaded

**Server logs** (terminal running `jupyter lab`):

- Check for Python errors or exceptions
- Verify backend routes are registered
- Look for HTTP request logs

---

### Troubleshooting: Extension Not Appearing

If your extension doesn't appear in JupyterLab after building:

**1. Check if the extension is installed:**

```bash
jupyter labextension list
```

Your extension should appear as **"enabled"** and **"OK"**.

**2. If NOT in the list**, run the installation commands:

```bash
pip install -e .
jupyter-builder develop . --overwrite
jupyter server extension enable jupyter_dag
```

**3. Did you restart JupyterLab?**

- Changes require a full restart (Ctrl+C in terminal, then `jupyter lab` again)
- Simply refreshing the browser is NOT enough for new extensions

**4. Ask user to check the browser console** (F12 or Cmd+Option+I):

- Request user to look for JavaScript errors that might prevent extension activation
- Ask user to search for the extension ID (`jupyter_dag`) to see if it loaded
- Ask user to report any error messages or warnings

**5. Verify the build output:**

```bash
ls -la lib/                          # Should contain compiled .js files
ls -la jupyter_dag/labextension/  # Should contain bundled extension
```

**6. If still not working**, try a clean rebuild following the reset instructions below

**Common causes:**

- ❌ Only ran `jlpm build` without installation commands
- ❌ Forgot to restart JupyterLab after installation
- ❌ Running commands outside the activated environment
- ❌ Build errors that were missed (check terminal output)

### Reset (if build state is broken)

```bash
jlpm clean:all       # Clean build artifacts
# git clean -fdX     # (Optional) Remove all ignored files including node_modules
jlpm install         # Only needed if you used 'git clean -fdX'
jlpm build
pip install -e ".[dev,test]"
jupyter-builder develop . --overwrite
jupyter server extension enable jupyter_dag
```

### Environment Notes

**✅ Do**: Use a virtual environment (conda/mamba/micromamba/venv)
**✅ Do**: Use `jlpm` exclusively
**❌ Don't**: Mix package managers (`npm`, `yarn`) with `jlpm`
**❌ Don't**: Mix lockfiles — keep only `yarn.lock`, not `package-lock.json`

## Best Practices

### Project Structure Alignment

**✅ Do**: Follow the template structure

- Keep configuration files in project root: `package.json`, `pyproject.toml`, `tsconfig.json`
- Backend routes: `jupyter_dag/routes.py`
- Server extension config: `jupyter-config/server-config/jupyter_dag.json`
- Frontend code: `src/index.ts` and other `src/` files
- Styles: `style/index.css`
- Settings schema: `schema/plugin.json`

**❌ Don't**: Rename or move core files without updating all references in configuration

### Version Management

**✅ Do**: Update version in `package.json` only

- The `package.json` version is the source of truth
- `pyproject.toml` automatically syncs from `package.json` via `hatch-nodejs-version`
- Follow semantic versioning: MAJOR.MINOR.PATCH

**❌ Don't**: Manually edit version in `pyproject.toml` — it's dynamically sourced from `package.json`

**Note**: Releases are handled by GitHub Actions, not manually. AI agents should only update versions when explicitly requested by the user.

### Development Approach

**✅ Do**: Start simple and iterate

- Begin with minimal functionality (e.g., a single command or widget)
- **When integrating backend/frontend**: See [Integration Workflow](#integration-workflow-critical) for the correct order
- Add backend routes or verbs only when frontend needs them
- Test in running JupyterLab frequently
- Ask user to check browser console and review terminal logs for errors

**❌ Don't**: Build complex features without incremental testing

**❌ Don't**: Write frontend interfaces without first checking the backend API contract in `jupyter_dag/routes.py`

## Common Pitfalls

### Package Management

**✅ Do**: Use `jlpm` consistently

```bash
jlpm install
jlpm build
```

**❌ Don't**: Mix package managers or lockfiles

- Don't use `package-lock.json` (this project uses `yarn.lock`)
- Don't run `npm install`

### Path Handling

**✅ Do**: Use relative imports in TypeScript (`src/` files)

```typescript
import { MyWidget } from './widgets/MyWidget';
```

**❌ Don't**: Use absolute paths or assume specific directory structures

### Error Handling

**✅ Do**: Wrap async operations in try-catch (in `src/api.ts`, widget code)

```typescript
try {
  const data = await fetchData();
} catch (err) {
  showErrorMessage('Failed to fetch data');
}
```

**❌ Don't**: Let errors propagate silently or crash the extension

### CSS and Styling

**✅ Do**: Namespace all CSS in `style/index.css`

```css
.jp-jupyter-dag-widget {
  padding: 8px;
}
```

**❌ Don't**: Use generic class names like `.widget` or `.button`

### Resource Cleanup

**✅ Do**: Dispose resources in widget `dispose()` methods

```typescript
dispose(): void {
  this._signal.disconnect();
  super.dispose();
}
```

**❌ Don't**: Leave event listeners or signal connections active after disposal

### Backend Integration

**✅ Do**: Use relative imports within your package

```python
from .routes import setup_route_handlers
```

**❌ Don't**: Use absolute imports like `from jupyter_dag.routes import ...`

## Quick Reference

### Key Identifiers

Use these patterns consistently throughout your code:

- **Plugin ID** (in `src/index.ts`): `'jupyter_dag:plugin'`
- **Command IDs** (in `src/commands.ts` or `src/index.ts`): `'jupyter_dag:command-name'`
  - For multiple commands, create `src/commands.ts` with a centralized `COMMANDS` mapping
  - For 1-2 commands, define directly in `src/index.ts`
- **CSS classes** (in `style/index.css`): `.jp-jupyter-dag-ClassName`
- **API routes** (in `jupyter_dag/routes.py`): `url_path_join(base_url, "jupyter_dag", "endpoint")`

### Essential Commands

See [Development Workflow](#development-workflow) section for full command reference.

---

# Project context

The section below is the former `.claude/CLAUDE.md`, merged here verbatim on September 16, 2026. `.claude/CLAUDE.md` is now a symlink to this file. Relative paths in it are written from the `.claude/` directory.

# Jupyter Day 2026 — "Children of Jupyter"

Context for Claude Code. This project began as a long chat (September 10–14, 2026);
`.claude/transcript-design.md` is a condensed record of that chat and `.claude/artifacts/` holds the
outputs. Read these files:

- `.claude/transcript-design.md`
- `.claude/transcript-design-verbatim.md`
- `.claude/transcript-code.md`
- Everything under `.claude/artifacts`

## Who

Max Klein (GitHub: telamonian). JupyterLab contributor since 2019; Distinguished
Jupyter Contributor 2023; has worked on JupyterLab, jupyterlab-git, Jupyter Server,
Jupyter Enterprise Gateway. Employed by a large company where he helps run its
internal enterprise Jupyter platform; speaks at Jupyter events as a contributor,
not for his employer. Does not name the employer in public materials.

## The event

Jupyter Day 2026, Monday October 19, 2026, San Jose Convention Center (Linux
Foundation, co-located with PyTorch Conference NA). CFP on Sessionize; the CFP
guide is https://events.linuxfoundation.org/jupyter-day/program/cfp/ . Talk is a
25-minute presentation. Description field has a hard 1,200-character limit.
Topic: Community. Audience level: Intermediate. Notifications Sept 21, 2026.

## The talk

Working title "Children of Jupyter" (suggested subtitle: "What Core Should Steal
Back"). Thesis: Jupyter's kernel/protocol design (built 2010, shipped in IPython
0.11 in July 2011; the notebook shipped in 0.12, December 2011) has aged well and
is what Colab, VS Code, Deepnote and ChatGPT's Python tool run on; the notebook
around it has not changed its execution model since 2011. The descendants
(Observable, Pluto, marimo, Hex, Livebook, Deepnote, Streamlit, ...) shipped fixes.
The talk surveys the significant new features, grouped by idea, with demos, then
argues opt-in reactive execution is the feature to adopt first and shares an
in-progress design and prototype for adding reactivity to the kernel messaging
protocol so any kernel can implement it.

Acts (25 min): opener (history + kernel/protocol split, ~3 min); reactive
execution; the environment inside the file; cells beyond code (SQL cells, input
cells, no-code cells, Livebook smart cells, anywidget); notebooks in space
(canvases, graphs); notebook → app → job → agent (ending on ChatGPT's tool being
"a stateful Jupyter notebook environment"); what core already took back
(RTC, JupyterLite) and the proposal. See `artifacts/talk-outline.md`.

## The framework ("genes")

Four traits of a Jupyter notebook; a descendant "changed a gene" only for a
significant departure, not a reimplementation:
- execution model (persistent namespace, user-ordered REPL)
- file (list of typed cells with optional outputs)
- cells (code + prose cells, one language, ordered list)
- client (a human editing and running cells)
Colab, VS Code, nteract, Jupytext, JupyterLite change none → distributions, not
descendants. Full classification table in `artifacts/genome-model.md`; figure in
`artifacts/family-tree-v3.svg`.

## Prior art that must be acknowledged

JupyterCon 2025 (San Diego, Nov 4–5): Stephen Macke, "Exploring the Design Space of
Reactive Notebooks" (ipyflow; recommended first-class reactive support in Jupyter);
Ian Thomas, "Subshells" (model for a protocol-level, language-agnostic feature:
JEP → ipykernel → other kernels); Billy Li, "World's First Undoable Notebook"
(Kishu checkpointing, Python-only); Timothy Tamm, "DBLS" (language server embedded
in the kernel); Kyle Kelley, "Runtime Agents" (precedent for bold "it's time to"
tone). All accepted descriptions are in
`artifacts/jupytercon-2025-accepted-talks.md`. Max knows Macke personally.

## The proposal (the design behind "Jupyter-DAG")

Name is a working name only; do not present it as an existing project.
Minimal kernel-protocol additions that serve both reactive execution and a
user-drawn cell DAG (they differ only in where edges come from):
1. `analyze_request` → per-cell defined/referenced names (kernel has the parser;
   optional feature; manual wiring is the fallback). Run on the control channel
   since it needs no namespace access. Optional `namespace_delta` on
   `execute_reply`.
2. namespace ops: delete (needed for "no hidden state" invalidation) and set
   (JSON value → binding; inputs/parameters). `user_expressions` already covers
   get.
3. forkable execution scopes (shallow namespace copy / env with parent):
   reactive-grade branch isolation; Pluto's module trick is the Julia version.
Optional heavier tier: state snapshot/restore/clone (CRIU/DMTCP process-level via
a jupyter_client provisioner; language-native serialization like dill/Kishu; replay
as universal fallback). Advertise all via JEP 92 `supported_features`.
Frontend: React Flow (`@xyflow/react`, MIT) in a JupyterLab ReactWidget on the
same INotebookModel; Lumino CodeCell mounted inside custom nodes. The ComfyUI
litegraph fork is not viable (internal module, GPL repo, canvas-rendered nodes).
Details in `artifacts/kernel-design-notes.md`.

## Writing rules Max enforces

Plain, specific, first person where natural. No LLM tells: no "clear-eyed",
"innovations", "and more", "walk away with", "leverage", "robust", no tidy
"X. Not Y." contrast pairs, no "if/if not" symmetric hedges, no signpost
sentences ("The second benefit is..."), no category slips (a talk is not an
implementation). Don't overpromise: "in-progress design and prototype", never
"extension" or "JEP" as if they exist. Count characters against limits with a
script, not by eye. Keep replies short unless asked for detail.

## Status / next steps

- Description, Benefits to the Ecosystem, and bio are final
  (`artifacts/proposal-final.md`). CFP closed Sept 13, 2026 11:59 PM PDT.
- Next month: build the reactive-execution prototype (analyze_request in
  ipykernel via `transform_cell` + `ast`/`symtable`; namespace ops; scopes) and
  the React Flow DAG view; keep the talk's demos short and recorded.
- Slides: family tree (v3) as the map slide; five one-minute demos (marimo
  slider vs ipywidgets callback, Pluto cell deletion, Livebook smart cell convert
  to code, Hex graph view, the prototype).
