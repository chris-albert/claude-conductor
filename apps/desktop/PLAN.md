# PLAN.md: Electron Console + Network Capture for BrowserPanel

## 1. Architecture (prose)

**Main process (`apps/desktop`)** owns one `WebContentsView` per `(sessionId, browserSlot)`. It mounts the view onto the existing `BrowserWindow`'s `contentView`, positioned with absolute pixel bounds the renderer streams in. It attaches `webContents.debugger` (CDP `1.3`), enables `Runtime`, `Log`, `Network`, and forwards every event over IPC to the renderer that owns that view. Response bodies are *not* eagerly captured; the renderer can ask for one on click.

**Renderer (`apps/web`)** detects `window.electronAPI.isElectron`. When true, `BrowserPanel` does not render an `<iframe>`; instead it renders a sized placeholder `<div ref>` and a tab strip (Preview / Console / Network) below the URL bar. A `ResizeObserver` + `getBoundingClientRect` push placeholder bounds to main over IPC. The native view sits on top of the placeholder; when the user switches to Console/Network, the renderer tells main to *hide* the view (off-screen bounds or `view.setVisible(false)`) and shows the React panels instead, drawing from a per-session capture store.

**Capture store** lives in `apps/web/src/lib/browserCapture.ts`, ring-buffered (e.g. 2000 entries each), keyed by `sessionId`.

## 2. File-by-file changes

### `apps/desktop` — created
- `src/browserViewManager.ts` — class `BrowserViewManager` with `create(sessionId, opts)`, `setBounds`, `setVisible`, `navigate`, `reload`, `goBack/Forward`, `destroy`, `getResponseBody(requestId)`. Owns a `Map<viewId, { view, debugger, requestIndex }>`.
- `src/cdpAttach.ts` — pure helpers: `attachDebugger(view)`, `enableDomains(dbg)`, event-to-IPC mapper.
- `src/ipc/browserView.ts` — registers `ipcMain.handle` for all `browserView:*` channels listed below. Imports the manager.

### `apps/desktop` — modified
- `src/main.ts` — `createWindow`: switch to `new BrowserWindow(...).contentView` model is already default in Electron 33; just add `import './ipc/browserView'` and instantiate `BrowserViewManager` with a reference to `mainWindow`. Add `mainWindow.on('resize')` handler that re-emits last-known bounds to keep views aligned. No behavior change unless the renderer calls `browserView:create`.
- `src/preload.ts` — extend `contextBridge.exposeInMainWorld('electronAPI', ...)` with: `browserView: { create, destroy, setBounds, setVisible, navigate, reload, goBack, goForward, getResponseBody, onConsole(cb), onRequest(cb), onResponse(cb), onLoadingFinished(cb), onException(cb) }`. Each `on*` returns an unsubscribe fn and uses `ipcRenderer.on` with channel-prefixed events.

### `apps/web` — created
- `src/lib/browserCapture.ts` — store with `addConsole(sessionId, entry)`, `addRequest`, `patchResponse`, `useConsole(sessionId)`, `useNetwork(sessionId)`, `clear(sessionId)`. Ring buffer cap constants.
- `src/components/BrowserConsolePanel.tsx` — virtualized list of entries; level icon, message, source `file:line`, timestamp. Filter by level + text in Phase 3.
- `src/components/BrowserNetworkPanel.tsx` — table rows: method, URL (truncated), status, type, size, time. Click row to expand request/response headers and lazy-load body via `getResponseBody`.
- `src/components/ElectronWebView.tsx` — the placeholder `<div>` + bounds reporter hook; mounts/unmounts the native view; exposes imperative `navigate/reload`.
- `src/lib/electronApi.ts` — typed wrapper around `window.electronAPI` with a `isElectron` guard, so callers don't poke `window` directly.

### `apps/web` — modified
- `src/components/BrowserPanel.tsx` — split into two paths inside the same component. New top-level: `if (electronAPI?.isElectron) return <ElectronBrowserPanel />` else fall back to current iframe code unchanged. New `ElectronBrowserPanel` adds a sub-tab strip (`Preview | Console (n) | Network (n)`), keeps the URL bar + Ports row, and replaces the iframe div with `<ElectronWebView>`.
- `src/lib/types.ts` — add `ConsoleEntry`, `NetworkEntry`, `NetworkPhase` types.

## 3. IPC surface

All channels namespaced `browserView:*`. Invoke (renderer → main):

- `create({ viewId, sessionId, initialUrl, bounds })` → `{ ok }`
- `destroy({ viewId })`
- `setBounds({ viewId, x, y, width, height })`
- `setVisible({ viewId, visible })`
- `navigate({ viewId, url })`
- `reload({ viewId })` / `goBack` / `goForward`
- `getResponseBody({ viewId, requestId })` → `{ body, base64Encoded }`
- `clearCapture({ viewId })`

Push (main → renderer), prefixed with `viewId`:

- `browserView:console` → `{ viewId, level, text, source, url, lineNumber, timestamp, stackTrace? }`
- `browserView:exception` → `{ viewId, message, stack, url, lineNumber, timestamp }`
- `browserView:request` → `{ viewId, requestId, method, url, headers, postData?, timestamp, type }`
- `browserView:response` → `{ viewId, requestId, status, statusText, mimeType, headers, timing, fromCache }`
- `browserView:loadingFinished` → `{ viewId, requestId, encodedDataLength, timestamp }`
- `browserView:loadingFailed` → `{ viewId, requestId, errorText, canceled }`
- `browserView:navigated` → `{ viewId, url }` (clears in-flight CDP state)

## 4. WebContentsView lifecycle

- **One view per `sessionId`**, lazy-created when `BrowserPanel` mounts for a session that has at least one port (or when user types a URL). `viewId === sessionId` for v1.
- On mount, renderer reports placeholder bounds via `ResizeObserver` + a window `resize` listener + tab-switch effects. Bounds are rect-relative to `BrowserWindow` content area; renderer computes via `getBoundingClientRect()` (no scroll offset since panel is full-height flex).
- On switching the parent app tab away from Browser, renderer calls `setVisible(false)` (or sets bounds to `{x:-99999,...}` as a fallback — `setVisible` exists on `WebContentsView` in Electron 33).
- On session close (`removeSession` in store) — add an effect in `ElectronBrowserPanel`'s cleanup that calls `destroy({ viewId })`. Also destroy on `app` `before-quit`.
- **Bounds gotcha**: `WebContentsView` paints in screen coordinates within the window; it does not clip to React DOM. Keep a 1px-accurate floor()/round() and drive a `requestAnimationFrame`-throttled bounds push (don't fire on every resize tick).

## 5. CDP attachment + events

After `view.webContents.loadURL(url)` (and on every `did-start-navigation` to re-attach if detached):

```
dbg.attach('1.3')
dbg.sendCommand('Runtime.enable')
dbg.sendCommand('Log.enable')
dbg.sendCommand('Network.enable', { maxResourceBufferSize: 5_000_000, maxTotalBufferSize: 20_000_000 })
dbg.sendCommand('Page.enable')   // for frameNavigated → emit 'navigated'
```

Listen on `dbg.on('message', (event, method, params) => ...)`:

- `Runtime.consoleAPICalled` → `console`
- `Runtime.exceptionThrown` → `exception`
- `Log.entryAdded` → `console` (browser-emitted warnings: CSP, deprecation)
- `Network.requestWillBeSent` → `request` (store request in main-side `requestIndex` keyed by `requestId`)
- `Network.responseReceived` → `response`
- `Network.loadingFinished` → `loadingFinished` (drop request from index unless body fetched)
- `Network.loadingFailed` → `loadingFailed`
- `Page.frameNavigated` (mainFrame) → `navigated`

Response bodies are fetched *only* when renderer calls `getResponseBody` → main calls `Network.getResponseBody`. Cap returned body at e.g. 2 MB; truncate with a flag.

Re-attach on crash via `webContents.on('render-process-gone')` and on `debugger.on('detach')`.

## 6. Renderer state shape

Separate from `SessionState` to keep churn out of `store.ts`. In `browserCapture.ts`:

```
interface CaptureState {
  console: ConsoleEntry[];        // ring, max 2000
  requests: Map<string, NetworkEntry>;  // by requestId; phase: 'sent' | 'response' | 'finished' | 'failed'
  requestOrder: string[];         // ordered ids, max 1000 (drop oldest)
}
const stores = new Map<sessionId, CaptureState>();
```

Hook API: `useConsole(sessionId)`, `useNetwork(sessionId)`. Same `useSyncExternalStore` pattern as `store.ts`. IPC listeners are registered once in `App.tsx` (or a `<BrowserCaptureBridge />` mounted at root) and fan out into the right session store via `viewId === sessionId`.

## 7. UI wireframe

```
┌── URL bar ───────────────────────────────────────┐
│ [⟳] [http://localhost:5173        ] [↗]          │
├── Ports row (existing) ──────────────────────────┤
│ Ports: :5173 :8080                                │
├── Sub-tabs (new, Electron only) ─────────────────┤
│ Preview | Console (12) | Network (47)  [Clear]    │
├──────────────────────────────────────────────────┤
│                                                   │
│   <ElectronWebView placeholder>  (or panel)       │
│                                                   │
└──────────────────────────────────────────────────┘
```

Console panel: monospace rows, level color (gray/yellow/red), `file:line` right-aligned, click to expand stack. Network panel: dense table; click row to open a side drawer with Headers / Payload / Response / Timing tabs.

## 8. Phase split

- **Phase 1 — Console + chrome.** Manager + IPC wiring, `WebContentsView` mount with bounds tracking, `Runtime.consoleAPICalled` + `Runtime.exceptionThrown` + `Log.entryAdded`, `BrowserConsolePanel`, sub-tab strip, electron-only branch in `BrowserPanel`. Web build untouched. *This alone is the win.*
- **Phase 2 — Network.** `Network.*` events, `NetworkEntry`, `BrowserNetworkPanel` table + side drawer, lazy `getResponseBody`, navigation-clears-network behavior toggle.
- **Phase 3 — Polish.** Filters (level, text, status, method, type), search, response-body size cap UI, copy-as-curl, preserve-log toggle, "show only XHR/Fetch", clear-on-navigate, badge counts, persist last 200 entries to disk per session (optional).

## 9. Risks / gotchas

- **Bounds desync**: any layout change without a `ResizeObserver` fire (e.g. CSS transition, parent tab restore) leaves the native view stale. Mitigate with a `requestAnimationFrame` loop bound to the panel's visibility, plus a `BrowserWindow` `resize`/`move` listener in main that re-applies last bounds.
- **Tab-switch flicker**: Toggle `setVisible(false)` *before* unmounting the placeholder; restore after layout settles in a `useLayoutEffect`.
- **Debugger detach on navigation**: `webContents.debugger.attach` survives navigations, but extension/devtools-open can detach. Listen `debugger.on('detach', reason)` and re-attach unless reason is `'target closed'`.
- **CSP / `frame-ancestors`**: irrelevant once we're not in an iframe — call this out in the PR description; sites that broke before should now load.
- **Large response bodies**: never auto-fetch; only on user click; truncate at 2 MB; show a "body too large" notice.
- **Multiple parallel sessions**: one view per session. Only the active session's view is visible; others are `setVisible(false)`. Capture buffers keep filling in background — desirable, but cap ring sizes aggressively.
- **Devtools on the embedded view**: expose a "Open DevTools for preview" command (`view.webContents.openDevTools({ mode: 'detach' })`) — useful while debugging the capture itself.
- **Packaging**: `WebContentsView` is main-process only; ensure `apps/desktop`'s build output still lists `preload.js` next to `main.js` after the preload grows.
- **Renderer reload (HMR)**: dev rebuilds of `apps/web` will drop IPC listeners; re-register on every mount of `BrowserCaptureBridge`. Main-side views persist across renderer reloads; on `did-finish-load` of `mainWindow`, push a `browserView:hello` so renderer re-binds to existing views without recreating.

### Critical Files for Implementation
- /Users/christopheralbert/git/claude-conductor/apps/desktop/src/main.ts
- /Users/christopheralbert/git/claude-conductor/apps/desktop/src/preload.ts
- /Users/christopheralbert/git/claude-conductor/apps/web/src/components/BrowserPanel.tsx
- /Users/christopheralbert/git/claude-conductor/apps/web/src/lib/store.ts
- /Users/christopheralbert/git/claude-conductor/apps/web/src/lib/types.ts
