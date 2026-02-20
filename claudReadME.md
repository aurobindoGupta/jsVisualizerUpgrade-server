# Refactor Changelog — js-visualizer-10000-server

Full refactor from plain JavaScript (Node 11) to TypeScript + Express (Node 18 LTS).

---

## Changes Made

1. **Upgraded Node.js engine requirement** from `11.x` (EOL 2020) to `>=18.0.0` LTS, removing the obsolete `--experimental-worker` flag from the start script.

2. **Replaced `vm2` (abandoned sandbox) with Node's built-in `vm` module** — `vm2` had unpatched security vulnerabilities and was no longer maintained. The built-in `vm.createContext()` + `vm.runInContext()` provides equivalent sandboxing with an active maintenance path.

3. **Replaced `babel-core@6` (EOL Babel 6) with `@babel/core@7`** — Babel 6 reached end-of-life in 2018. Migrated to the modern `@babel/core` monorepo package and updated all transform calls to use `babel.transformSync()`.

4. **Replaced `falafel` (unmaintained AST manipulator) with `@babel/traverse` + `@babel/parser` + `@babel/generator`** — `falafel` had not been updated since 2016. The new implementation uses the official Babel AST pipeline to instrument function bodies with enter/exit/error tracing, handling all edge cases (arrow functions with implicit returns, named expressions, object method shorthand).

5. **Removed `node-fetch`** — Node 18+ ships a native `fetch` global, making this dependency unnecessary.

6. **Removed `recast`** — was imported but never meaningfully used in the codebase.

7. **Removed `ast-types`** — replaced by `@babel/types` as part of the Babel 7 migration.

8. **Upgraded `ws` from `^6.1.3` to `^8.x`** — adds full TypeScript typings and drops end-of-life Node support.

9. **Added TypeScript 5** with strict mode — all source files converted from `.js` to `.ts` with full type annotations, discriminated union event types, and typed interfaces for all worker communication payloads.

10. **Added Express 4** — replaced the bare WebSocket-only server with an Express HTTP server. WebSocket (`ws`) is mounted on the same HTTP server, enabling proper HTTP upgrade handling alongside REST endpoints.

11. **Added `GET /health` endpoint** — returns `{ "status": "ok" }` for load balancer / uptime monitoring use.

12. **Added `cors` middleware** — enables cross-origin requests from the frontend client.

13. **Added `pino` structured logging** — replaced all scattered `console.log` / `console.error` calls with a structured `pino` logger. Uses `pino-pretty` in development for readable output; emits JSON in production.

14. **Added a shared `src/types/events.ts` module** — defines the `EventType` union type and `ExecutionEvent` interface used across both the main thread and worker, eliminating duplicated magic strings.

15. **Fixed `async_hooks` memory leak** — the `destroy` hook previously did nothing, so `asyncIdToResource` grew indefinitely for the lifetime of the process. It now correctly calls `delete asyncIdToResource[asyncId]` and `delete asyncIdToType[asyncId]` on every destroy.

16. **Improved `async_hooks` resource-type detection** — replaced fragile `resource.constructor.name` string checks in `before`/`after` hooks with a dedicated `asyncIdToType` map populated in `init`, making the code robust against V8 internal name changes.

17. **Rewrote `launchWorker` as a Promise-based API** — returns `{ promise, worker }`. The promise resolves with the full event array once a terminal event (`Done`, `EarlyTermination`, `UncaughtError`) is received. The caller retains a reference to `worker` to terminate it on client disconnect.

18. **Added external hard timeout (8 s) in `launchWorker`** — the main thread calls `worker.terminate()` unconditionally after 8 seconds as a hard backstop, in addition to the 5 s internal timeout inside the worker. This catches promise hell and any other async work that prevents the worker from exiting naturally.

19. **Fixed absolute worker file path** — the original code used a relative path string `'./src/worker/worker.js'` that broke when the process was started from a different working directory. The new code uses `path.resolve(__dirname, ...)` for a reliable absolute path. In development (`ts-node`), the worker is loaded as `.ts` with `execArgv: ['--require', 'ts-node/register']`; in production it loads the compiled `.js` from `dist/`.

20. **Fixed loose equality bugs in `eventsReducer`** — two event-type comparisons used `==` instead of `===` (`ExitFunction` and `ErrorFunction` checks on lines 22–23 of the original file). Fixed to strict equality throughout.

21. **Replaced `lodash` chain in `eventsReducer` with native array methods** — the deduplication of `ResolvePromise` events was rewritten using `Set` and standard `Array` methods, removing the runtime dependency on lodash for this operation.

22. **Removed debug `console.log` from `eventsReducer`** — a verbose `console.log({ resolvedPromiseIds, ... })` statement that leaked internal state to stdout on every execution was removed.

23. **Updated `loopTracer` from Babel 6 plugin format to Babel 7** — the plugin now uses `@babel/types` directly and handles non-block loop bodies (e.g., `for (;;) doSomething()`) by wrapping them in a `BlockStatement` before appending the guard call, preventing a runtime crash on single-statement loops.

24. **Fixed typo** — `"Termianted early"` → `"Terminated early"` in the `EarlyTermination` event message.

25. **Removed synchronous file I/O (`log.txt`)** — the worker previously wrote every async hook event to disk synchronously using `fs.appendFileSync`, which blocked the worker thread on every event. All file-based logging has been removed; debug output is handled via `parentPort.postMessage` or simply omitted.

26. **Added `tsconfig.json`** — `target: ES2022`, `module: CommonJS` (required for `worker_threads` file loading), `strict: true`, `esModuleInterop: true`, source maps enabled.

27. **Added `jest.config.ts`** — Jest 29 + `ts-jest` preset configured for TypeScript unit tests under `src/**/*.test.ts`.

28. **Updated `.gitignore`** — added `dist/` (compiled output directory); removed `log.txt` and `log-app.txt` (no longer generated).

29. **Renamed project** from `js-visualizer-9000` to `js-visualizer-10000` across `package.json` and `README.md`.

30. **Rewrote `README.md`** — documents the new stack (Node 18+, TypeScript, Express), setup and run instructions (`npm run dev`, `npm run build`, `npm start`), the WebSocket URL for the frontend (`ws://localhost:8080`), the health check endpoint, environment variables, the event protocol, a worked example, and the two-layer timeout/safeguard architecture.

---

## async_hooks Tracer Improvements — Noise Filtering & Anonymous Naming

31. **Blacklisted `TickObject` resource type** (`src/worker/worker.ts`) — added to `IGNORED_HOOK_TYPES`. `TickObject` resources are created by `process.nextTick`, which is not exposed in the VM sandbox, so these are always CJS module-loader noise and should never appear in the visualizer.

32. **Fixed internal kill timer leaking into the event stream** (`src/worker/worker.ts`) — the worker's internal 5 s hard-kill `setTimeout` was created *after* `asyncHooks.createHook(...).enable()`, causing its `init` hook to fire and produce a spurious `InitTimeout` event. The timer is now created *before* the hook is enabled (so `init` never fires for it) and `.unref()` is chained on the return value as a belt-and-suspenders measure.

33. **Added trigger-based parent filter to `init` hook** (`src/worker/worker.ts`) — resources whose `triggerAsyncId` is neither the worker's root execution context nor an already-tracked resource are now silently dropped. This eliminates children of blacklisted infrastructure handles (e.g. TCP connections or HTTP parser resources spawned internally by `fetch`/undici) from reaching the event stream. `ROOT_ASYNC_ID` is captured dynamically via `asyncHooks.executionAsyncId()` rather than hardcoded to `1`, because in a CJS worker thread the root context ID is assigned by the module loader (not always `1`).

34. **Added `hasRef()` guard for `Timeout` resources** (`src/worker/worker.ts`) — fetch/undici keepalive timers call `.unref()` immediately after construction. The `init` hook now checks `resource.hasRef()` and skips any Timeout resource that returns `false`, preventing internal library timers from appearing as `InitTimeout` events. The `asyncIdToType` / `asyncIdToResource` map writes are moved inside each type-specific branch so that an early-return from the `hasRef()` guard does not leave stale entries.

35. **Added `getCreationLabel` stack-trace helper** (`src/worker/worker.ts`) — a new helper function walks the current call stack at the moment an async resource is created, looking for a VM context frame (`evalmachine.<anonymous>:N:N`). If found, it returns `'Callback at line N'`; otherwise it returns a semantic fallback (`'Promise Reaction'` or `'Async Callback'`). This label is attached to every `InitPromise`, `InitMicrotask`, and anonymous `InitTimeout` event.

36. **Added `label` field to `InitPromise` and `InitMicrotask` events** (`src/worker/worker.ts`) — both events now carry a human-readable `label` string in their payload. Named callbacks already carry their function name; this field gives anonymous ones a meaningful source-location tag (e.g. `'Callback at line 5'`) instead of a blank box.

37. **Captured resolved Promise value in `promiseResolve` hook** (`src/worker/worker.ts`) — uses `process.binding('util').getPromiseDetails` (accessed via a type-safe `unknown` cast, cached at worker startup behind a `try/catch`) to synchronously inspect the fulfilled value of a Promise at the moment it resolves. If the state is fulfilled and the value is non-null, it is serialized with `prettyFormat` and included as `resolvedValue` in the `ResolvePromise` event payload. Degrades silently on Node 20+ where the internal binding was removed.

38. **Set `microtaskMode: 'afterEvaluate'` on the VM context** (`src/worker/worker.ts`) — `vm.createContext` now receives `{ microtaskMode: 'afterEvaluate' }` as its second argument. This causes the VM to flush all pending microtasks (Promise `.then()` callbacks, `queueMicrotask`) immediately after `runInContext` returns, ensuring that `BeforePromise` / `AfterPromise` async hook events are emitted and captured before the worker finishes, rather than being deferred to a later event-loop tick.

39. **Added anonymous-name label fallback in `eventsReducer`** (`src/main/eventsReducer.ts`) — `reduceEvents` now builds an `asyncIdToLabel` lookup from all `InitPromise` and `InitMicrotask` events. When constructing `EnqueueMicrotask` events, if the traced function name is `'anonymous'`, the reducer substitutes the corresponding label from the lookup (e.g. `'Callback at line 5'`), falling back to `'Promise Reaction'` or `'Async Callback'`. Named callbacks are unaffected.
