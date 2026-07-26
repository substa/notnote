# Architecture

## Overview

notnote has no compilation step or runtime package dependency. `index.html` applies the saved appearance with a small inline bootstrap before loading `styles.css`, `theme-config.css`, `graph.js`, and `app.js` directly. `sw.js` serves its versioned offline application shell cache-first, while checking for a new Service Worker in the background. `server.py` is an optional Python standard-library HTTP server for sharing one graph.

The root layout is deliberate: the browser receives the same files that a developer edits, so there is no generated directory that can drift from source. Large interface behavior remains in `app.js` to preserve a simple script loading order and deployment model. Pure graph parsing, indexing, date handling, and storage adapters live in `graph.js` and can be tested in Node without a DOM.

## Responsibilities

| Path | Responsibility |
| --- | --- |
| `index.html` | Accessible application structure and dialogs. |
| `app.js` | Rendering, editor commands, user interaction, and application state. |
| `graph.js` | Markdown graph model, index, filesystem/remote adapters, and offline queue. |
| `styles.css` | Layout and component styling. |
| `theme-config.css` | Theme variables and intentionally easy overrides. |
| `sw.js` | Static shell and bounded attachment cache; graph API data is not broadly cached. |
| `server.py` | Static allowlist, graph API, atomic writes, conflict checks, events, and optional Git integration. |
| `docker/` | Container image, Compose deployment, environment template, and build exclusions. |
| `tests/` | DOM-independent JavaScript behavior and Python server security/integration tests. |

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

## Adding a runtime file

A new browser runtime file normally needs to be added in four places:

1. `index.html` if it is loaded by the page;
2. `server.py`'s `STATIC_FILES` allowlist;
3. `sw.js`'s `ASSETS` list, followed by a cache-name increment;
4. `docker/Dockerfile` so container builds copy it.

Add tests and update documentation in the same change.
