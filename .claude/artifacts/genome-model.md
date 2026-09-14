# The "genome" model of Jupyter descent (v3, simplified)

Only significant changes count as a mutated gene; reimplementations of the same
idea do not. Four genes:

**Execution model** — a persistent shared namespace where the user decides what
runs and in what order. Changed when the runtime decides (reactive dataflow),
when out-of-order execution is forbidden (Livebook, Polynote), when everything
reruns from the top (Streamlit), or when state forks (Livebook branching
sections, Kishu). Not changed by where the kernel runs, what language it speaks,
threads, or subshells.

**File** — a list of typed blobs with optional outputs. JSON, Markdown, Python
with cell markers are all the same idea; dropping stored outputs is too. Changed
when the file carries something a cell list doesn't: dependency lock/environment
(Pluto's Manifest, marimo's PEP 723 block), an execution cache (marimo exports),
project-level config (Deepnote's manifest) — or when there is no cell list at all.

**Cells** — the notebook model: an ordered list of code cells in the kernel's
language plus prose. Changed when cells can be something else (SQL executed
elsewhere, inputs, no-code spec cells, smart cells) or stop being a list
(canvas, graph). Not changed by magics, annotations on code cells (Colab forms),
or a language switch inside one runtime (Databricks, borderline).

**Client** — a human editing and running cells one at a time; any notebook editor
qualifies, official or not. Changed when the notebook is consumed without an
editor: app, job/API, agent; or when the surface isn't a cell editor.

## Classification

| Project | Execution | File | Cells | Client |
|---|---|---|---|---|
| Colab · VS Code · nteract · Jupytext · JupyterLite | — | — | — | — |
| papermill / Jupyter Scheduler | — | — | — | job |
| Voilà | — | — | — | app |
| Jupyter AI | — | — | — | agent |
| Databricks | — | — | multi-language (borderline) | jobs |
| Quarto | — | freeze cache (borderline) | — | publishing |
| Datalore | — | — | SQL cells | report apps |
| Deepnote | — | project manifest | SQL, input, chart blocks | apps, endpoints |
| Observable | reactive | — | SQL cells, inputs | published, Framework |
| Pluto.jl | reactive | Manifest embedded | — | static export (borderline) |
| Hex | reactive DAG | project config | SQL, input, chart cells; graph | apps, agent |
| Livebook | enforced order, branching sections | — | smart cells, setup cell | apps |
| marimo | reactive | PEP 723 deps, cached export | SQL cells | app, script, ASGI, agent |
| ipyflow / Kishu (inside Jupyter) | reactive / checkpoints | — | — | — |
| jupyter-dag (proposed) | DAG, branches | — | graph | — |
| Count | reactive | — | canvas | canvas |
| Streamlit | rerun from top | script, no cells | none | app only |
| Quadratic / Python in Excel | recalculation | grid | grid | spreadsheet |
| ChatGPT tool / E2B | — | none | none | agent |

## Consequences for the talk

- Colab, VS Code, Datalore-as-editor etc. are distributions, not descendants.
- Jupyter has mutated its own client gene via subprojects since 2017 (papermill,
  Voilà, Jupyter AI) but has never mutated its execution gene in core; that has
  happened only in third-party kernels (ipyflow, akernel, Kishu). That is the gap
  the proposal targets.
- The file gene never defines a branch on its own; every project that changed
  the file also changed something else. Worth saying in the "file is the program"
  act: the file format is the gene the children treat as a consequence, not a cause.
- Judgment calls a reviewer may push on: Livebook in the execution column rests on
  enforced order + branching sections, not reactivity; Databricks sits in "new
  client" on the strength of jobs.

## Figure

`family-tree-v3.svg`: root (Jupyter, four genes), a strip of same-genome
distributions, five branches ordered by how much genome survives (new client;
new cells; new execution; kernel only; idea only), an extinct row (Beaker '14,
Polynote '19, Noteable '22–24, Kotlin Notebook '23–26). Filled dot = kept,
hollow dot + strikethrough = changed.

## Corrected history to use on slides

- Kernel/protocol designed 2010 (Granger, Pérez; pyzmq with Ragan-Kelley; GSoC Qt
  console), shipped IPython 0.11 July 2011; notebook + .ipynb shipped IPython 0.12
  December 21, 2011; Jupyter named 2014, "Big Split" IPython 4.0 in 2015.
- RTC: co-developed with Google as "CoLaboratory" in 2014 (repo under jupyter org;
  Chrome app ran code in-browser via PNaCl); Jupyter side became
  jupyterlab-google-drive on Google's Realtime API, which Google deprecated
  Nov 2017 / shut down Dec 2018; children had RTC (Colab, CoCalc, Deepnote, Hex)
  until JupyterLab 3.1 rebuilt it on Yjs in 2021; jupyter_collaboration in Lab 4.
- JupyterLite (2021) credits Jyve, Iodide (Mozilla; Pyodide began as its plugin),
  Basthon, p5 notebook.
- Subshells (JEP 91) are not reabsorbed from a child: internally motivated
  (widgets, variable inspectors, control-channel abuse); akernel was the in-family
  prototype. Jupytext is not in core.
- Better "taken back" examples: debugger (JEP 47, 2020) after PyCharm 2019;
  Jupyter Scheduler (2022) after papermill/Netflix, Databricks Jobs; Jupyter AI
  (2023) alongside Hex Magic, Noteable's ChatGPT plugin, Colab AI.
