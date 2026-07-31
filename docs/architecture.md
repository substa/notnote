# Architecture

## Overview

notnote has no runtime package dependency. `index.html` applies the saved appearance with `appearance-bootstrap.js`, loads the minified `app.bundle.css`, and starts the deferred `app.bundle.js`. The bundles reduce startup to one application script and one stylesheet request. `sw.js` serves its content-revisioned offline application shell cache-first, while checking for a new Service Worker in the background. `server.py` is an optional Python standard-library HTTP server for sharing one graph.

Browser behavior remains separated into feature-oriented ES modules under `app/`; imports expose dependencies and exports define each module's public API. `app/state.js` holds the small amount of intentionally shared mutable state, while feature-local state remains in its owner. Pure graph parsing, indexing, date handling, and storage adapters remain in `graph.js` and can be tested in Node without a DOM. A pinned esbuild version combines and minifies these sources into committed JavaScript and CSS bundles; CI rebuilds them and rejects source/bundle drift.

## Responsibilities

| Path | Responsibility |
| --- | --- |
| `index.html` | Accessible application structure and dialogs. |
| `appearance-bootstrap.js` | Applies saved theme settings before the interface is rendered. |
| `app.js` | Startup, graph restoration, and PWA registration source. |
| `app/` | Feature source modules for rendering, editing, commands, settings, interaction, and synchronization. |
| `graph.js` | Markdown graph model, index, filesystem/remote adapters, offline queue, and Node-test entry point. |
| `app.bundle.js` | Generated, minified browser artifact containing all application JavaScript. |
| `app.bundle.css` | Generated, minified browser stylesheet. |
| `scripts/` | Production entries and deterministic bundle build. |
| `styles.css` | Layout and component styling source. |
| `theme-config.css` | Theme variables and intentionally easy overrides. |
| `sw.js` | Static shell and bounded attachment cache; graph API data is not broadly cached. |
| `server.py` | Static allowlist, graph API, atomic writes, conflict checks, events, and optional Git integration. |
| `docker/` | Container image, Compose deployment, environment template, and build exclusions. |
| `tests/` | Graph, server security, module architecture, browser smoke, and performance regression tests. |

## Browser script layout

The source scripts are intentionally broad modules rather than many small abstractions. These boundaries exist for development; they do not add browser requests because production serves only the bundle:

| Path | Main contents |
| --- | --- |
| `app/dom.js` | Stable references to DOM elements shared by multiple features. |
| `app/state.js` | Graph API boundary plus serializable state and cross-feature session handles. |
| `app/core.js` | Routes, settings helpers, shortcuts, mobile behavior, lightweight contracts, and shared overlays. |
| `app/composition.js` | Wiring for the few bidirectional feature relationships and explicit event initialization. |
| `app/markdown.js` | Safe Markdown rendering, highlighting, and serialization. |
| `app/graph-view.js` | Graph rendering plus task and journal panels embedded in graph pages. |
| `app/graph-session.js` | Saves, page loading, navigation, references, and graph maintenance. |
| `app/outliner.js` | Block editing, selection, structural mutations, and autocomplete. |
| `app/media.js` | Asset upload and voice recording. |
| `app/vim.js` | Source-block editing, Vim behavior, and edit history. |
| `app/document.js` | Standalone document editing, persistence, formatting, statistics, and in-document search. |
| `app/settings.js` | Documentation and settings views, including Git controls. |
| `app/commands.js` | Formatting, command palette, block actions, page directory, history, and footer navigation. |
| `app/events/` | Dependency-leaf adapters explicitly initialized after feature composition. |
| `app/appearance.js` | Theme and persisted graph settings. |
| `app/lifecycle.js` | Global shortcuts, synchronization, browser events, and lazy journal loading. |

Keep feature state next to the functions that own it. Only state required by multiple features belongs in `state.js`. Feature modules must not import event adapters; `composition.js` initializes those leaf modules after feature dependencies have been composed. Direct imports are preferred; feature-specific configuration is reserved for relationships that would otherwise create a cycle. Small helpers stay with their owning domain instead of gaining a separate module. Structural tests enforce the acyclic graph. Keep expensive graph operations indexed or batched, and never replace safe rendering or path validation with direct HTML or filesystem access.

## Data flow

### Local graph

The browser receives a directory handle through the File System Access API. Markdown is parsed and indexed in memory. Writes go through a recovery draft in IndexedDB and then to the selected directory. The directory handle and recovery state remain browser-local.

### Server graph

The browser fetches the graph index from same-origin `/api/graph/*` routes. Saves include the last observed file revision. The server rejects stale writes and replaces files atomically. Server-Sent Events notify other clients of paths and revisions; note content is not placed in events.

A server-backed browser stores a replica and pending operations in IndexedDB. On later launches this replica is rendered immediately without waiting for the network; server status, settings, pending writes, and the authoritative file list are refreshed in the background. Existing-note edits and new pages can be queued offline. The server graph remains authoritative after successful synchronization.

### Optional Git history

Git is an adapter around already-saved graph files, not a storage requirement. If the executable or repository is absent, status reports history as unavailable and normal graph operations continue. notnote never initializes a repository, installs Git, pulls, resolves conflicts, or stores credentials.

## Trust boundaries

The writable server API has no identity system. Network reachability grants graph access. Production internet deployment therefore places authentication and TLS at a reverse proxy and keeps port 4176 private. Origin checks reduce browser cross-site writes but do not replace authentication.

All client-supplied paths are resolved beneath the graph root. Markdown writes are extension-restricted; assets are restricted to `assets/`; symlink escapes resolve outside the graph and are rejected. Static application serving uses an explicit allowlist so repository metadata and unrelated host files are not exposed.

Rendered Markdown is escaped before controlled markup is inserted. Links accept a limited set of schemes, and iframes accept HTTPS URLs from a small host allowlist reinforced by Content Security Policy.

## Operational characteristics

The server uses threads for concurrent static/API requests and keeps a metadata-keyed note cache to avoid rereading unchanged files. Writes share a mutation lock, use a same-directory temporary file, flush to disk, and atomically replace the destination. The graph watcher adapts its polling interval to graph size.

The container runs as the graph owner with a read-only application filesystem, a bounded temporary filesystem, dropped capabilities, no privilege escalation, bounded process count, loopback-only host publishing, health checks, and rotated logs. The default image excludes Git; `runtime-git` is an explicit optional target.

## Browser build and runtime files

After changing JavaScript, CSS, or a critical shell file, run `npm run build`. The generated bundles are committed so a checkout and the runtime container need neither Node.js nor npm. The build derives the Service Worker cache revision from both bundles, `index.html`, the appearance bootstrap, and the manifest; cache installation bypasses the HTTP cache, so deployed updates cannot reuse stale artifacts. `npm run build:check` is enforced by CI. Both bundles have explicit raw and gzip budgets, and the browser smoke test verifies that startup does not fetch source files.

A new module only needs an explicit source import followed by a rebuild. A new independently loaded browser asset must also be added to `server.py`'s `STATIC_FILES`, `sw.js`'s `ASSETS`, and `docker/Dockerfile` when necessary. Source modules are deliberately absent from the server allowlist and offline cache.

Keep event adapters as dependency leaves and avoid circular feature imports. New shared mutable values require a concrete cross-feature use case; otherwise keep them private to their module. Add tests and update documentation in the same change.
