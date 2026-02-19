# JavaScript Visualizer 10000 — Server

Backend WebSocket server for [js-visualizer-10000](https://jsv9000.app). Executes user-submitted JavaScript in an isolated worker thread, instruments the code for tracing, and streams execution events to the frontend client.

The companion frontend repo is [js-visualizer-10000-client](https://github.com/Hopding/js-visualizer-9000-client).

---

## Stack

- **Node.js** ≥ 18 LTS
- **TypeScript** 5
- **Express** 4 — HTTP server + health check
- **ws** 8 — WebSocket server mounted on Express
- **@babel/core** 7 + **@babel/traverse** — AST instrumentation (function tracing, loop guards)
- **async_hooks** (Node built-in) — promise, microtask, and timeout tracing
- **vm** (Node built-in) — sandboxed code execution
- **pino** — structured logging

---

## Prerequisites

- Node.js ≥ 18.0.0
- npm ≥ 9

---

## Setup

```bash
npm install
```

---

## Running

### Development (TypeScript, hot-reloads via ts-node)

```bash
npm run dev
```

### Production

```bash
npm run build   # compiles TypeScript → dist/
npm start       # runs dist/index.js
```

---

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Port the HTTP/WebSocket server listens on |
| `NODE_ENV` | — | Set to `production` to disable pino-pretty |

---

## Frontend Connection

Connect the frontend WebSocket client to:

| Environment | URL |
|---|---|
| Local development | `ws://localhost:8080` |
| Production (Heroku / Railway / etc.) | `wss://<your-deployed-hostname>` |

The [js-visualizer-10000-client](https://github.com/Hopding/js-visualizer-9000-client) defaults to `ws://localhost:8080` in development. Update its `SERVER_URL` environment variable when deploying to production.

---

## Health Check

```
GET http://localhost:8080/health
→ { "status": "ok" }
```

---

## WebSocket Protocol

### Client → Server

```json
{ "type": "RunCode", "payload": "<JavaScript source code>" }
```

### Server → Client

A JSON array of execution events is sent once the worker finishes (or is terminated):

```json
[
  { "type": "EnterFunction", "payload": { "id": 0, "name": "logA", "start": 0, "end": 36 } },
  { "type": "ConsoleLog",    "payload": { "message": "A\n" } },
  { "type": "ExitFunction",  "payload": { "id": 0, "name": "logA", "start": 0, "end": 36 } },
  ...
]
```

### Event types

| Category | Types |
|---|---|
| Call stack | `EnterFunction`, `ExitFunction`, `ErrorFunction` |
| Promises | `InitPromise`, `ResolvePromise`, `BeforePromise`, `AfterPromise` |
| Microtasks | `InitMicrotask`, `BeforeMicrotask`, `AfterMicrotask`, `EnqueueMicrotask`, `DequeueMicrotask` |
| Timers | `InitTimeout`, `BeforeTimeout` |
| Console | `ConsoleLog`, `ConsoleWarn`, `ConsoleError` |
| Rendering | `Rerender` |
| Lifecycle | `Done`, `UncaughtError`, `EarlyTermination` |

---

## Example

**Input code sent by the frontend:**

```js
function logA() { console.log('A'); }
function logB() { console.log('B'); }
function logC() { console.log('C'); }
function logD() { console.log('D'); }

logA();
setTimeout(logB, 0);
Promise.resolve().then(logC);
logD();
```

**Output event stream (simplified):**

```json
[
  { "type": "EnterFunction",    "payload": { "id": 0, "name": "logA", "start": 0,   "end": 36  } },
  { "type": "ConsoleLog",       "payload": { "message": "A\n" } },
  { "type": "ExitFunction",     "payload": { "id": 0, "name": "logA", "start": 0,   "end": 36  } },
  { "type": "InitTimeout",      "payload": { "id": 5, "callbackName": "logB" } },
  { "type": "InitPromise",      "payload": { "id": 6, "parentId": 2 } },
  { "type": "ResolvePromise",   "payload": { "id": 6 } },
  { "type": "EnqueueMicrotask", "payload": { "name": "logC" } },
  { "type": "EnterFunction",    "payload": { "id": 1, "name": "logD", "start": 111, "end": 147 } },
  { "type": "ConsoleLog",       "payload": { "message": "D\n" } },
  { "type": "ExitFunction",     "payload": { "id": 1, "name": "logD", "start": 111, "end": 147 } },
  { "type": "BeforePromise",    "payload": { "id": 7 } },
  { "type": "DequeueMicrotask", "payload": {} },
  { "type": "EnterFunction",    "payload": { "id": 2, "name": "logC", "start": 74,  "end": 110 } },
  { "type": "ConsoleLog",       "payload": { "message": "C\n" } },
  { "type": "ExitFunction",     "payload": { "id": 2, "name": "logC", "start": 74,  "end": 110 } },
  { "type": "Rerender",         "payload": {} },
  { "type": "BeforeTimeout",    "payload": { "id": 5 } },
  { "type": "EnterFunction",    "payload": { "id": 3, "name": "logB", "start": 37,  "end": 73  } },
  { "type": "ConsoleLog",       "payload": { "message": "B\n" } },
  { "type": "ExitFunction",     "payload": { "id": 3, "name": "logB", "start": 37,  "end": 73  } }
]
```

---

## Safeguards

Two layers of timeout protect against infinite loops and promise hell:

1. **Internal (5 s)** — a `setTimeout` inside the worker posts `EarlyTermination` and calls `process.exit(1)`. Loop bodies also call `Tracer.iterateLoop()` on every iteration to detect runaway loops early.
2. **External (8 s)** — the main thread calls `worker.terminate()` unconditionally after 8 seconds as a hard backstop.

The event limit (500 events) provides an additional guardrail against excessively verbose traces.

---

## Testing

```bash
npm test
```

Tests use **Jest** + **ts-jest**.

---

## Project Structure

```
src/
├── types/
│   └── events.ts          # Shared event type definitions
├── main/
│   ├── app.ts             # Express + WebSocket server
│   ├── launchWorker.ts    # Worker thread launcher (Promise-based, hard timeout)
│   └── eventsReducer.ts   # Normalises the raw event stream for the frontend
└── worker/
    ├── worker.ts          # Worker thread: AST instrumentation + vm sandbox + async_hooks
    └── loopTracer.ts      # Babel 7 plugin — injects loop iteration guards
```
