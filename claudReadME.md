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
