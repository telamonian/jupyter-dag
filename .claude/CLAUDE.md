# Jupyter Day 2026 — "Children of Jupyter"

Context for Claude Code. This project began as a long chat (September 10–14, 2026);
`transcript.md` is a condensed record of that chat and `artifacts/` holds the
outputs. Read this file first, then `artifacts/transcript-design-verbatim.md`, `artifacts/kernel-design-notes.md`, and
`artifacts/genome-model.md`.

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
