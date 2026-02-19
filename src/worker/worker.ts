import { parentPort, workerData } from 'worker_threads';
import asyncHooks from 'async_hooks';
import vm from 'vm';
import * as babel from '@babel/core';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import prettyFormat from 'pretty-format';
import _ from 'lodash';
import { traceLoops } from './loopTracer';
import type { ExecutionEvent, EventType } from '../types/events';

// @babel/traverse and @babel/generator ship as CommonJS with a `.default` export.
// With esModuleInterop these imports resolve correctly; the cast handles edge cases.
const traverse = (_traverse as unknown as { default: typeof _traverse }).default ?? _traverse;
const generate = (_generate as unknown as { default: typeof _generate }).default ?? _generate;

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

const makeEvent = (type: EventType, payload: Record<string, unknown> = {}): ExecutionEvent => ({
  type,
  payload,
});

const Events = {
  ConsoleLog: (message: string) => makeEvent('ConsoleLog', { message }),
  ConsoleWarn: (message: string) => makeEvent('ConsoleWarn', { message }),
  ConsoleError: (message: string) => makeEvent('ConsoleError', { message }),

  EnterFunction: (id: number, name: string, start: number, end: number) =>
    makeEvent('EnterFunction', { id, name, start, end }),
  ExitFunction: (id: number, name: string, start: number, end: number) =>
    makeEvent('ExitFunction', { id, name, start, end }),
  ErrorFunction: (message: string, id: number, name: string, start: number, end: number) =>
    makeEvent('ErrorFunction', { message, id, name, start, end }),

  InitPromise: (id: number, parentId: number) => makeEvent('InitPromise', { id, parentId }),
  ResolvePromise: (id: number) => makeEvent('ResolvePromise', { id }),
  BeforePromise: (id: number) => makeEvent('BeforePromise', { id }),
  AfterPromise: (id: number) => makeEvent('AfterPromise', { id }),

  InitMicrotask: (id: number, parentId: number) => makeEvent('InitMicrotask', { id, parentId }),
  BeforeMicrotask: (id: number) => makeEvent('BeforeMicrotask', { id }),
  AfterMicrotask: (id: number) => makeEvent('AfterMicrotask', { id }),

  InitTimeout: (id: number, callbackName: string) =>
    makeEvent('InitTimeout', { id, callbackName }),
  BeforeTimeout: (id: number) => makeEvent('BeforeTimeout', { id }),

  UncaughtError: (error: Error | null) =>
    makeEvent('UncaughtError', {
      name: error?.name ?? 'Error',
      stack: error?.stack ?? '',
      message: error?.message ?? 'Unknown error',
    }),
  EarlyTermination: (message: string) => makeEvent('EarlyTermination', { message }),
};

// ---------------------------------------------------------------------------
// Event posting
// ---------------------------------------------------------------------------

let eventCount = 0;

const postEvent = (event: ExecutionEvent): void => {
  eventCount++;
  parentPort!.postMessage(JSON.stringify(event));
};

// ---------------------------------------------------------------------------
// Async hook types we care about
// ---------------------------------------------------------------------------

const IGNORED_HOOK_TYPES = new Set([
  'FSEVENTWRAP', 'FSREQCALLBACK', 'GETADDRINFOREQWRAP', 'GETNAMEINFOREQWRAP',
  'HTTPPARSER', 'JSSTREAM', 'PIPECONNECTWRAP', 'PIPEWRAP', 'PROCESSWRAP',
  'QUERYWRAP', 'SHUTDOWNWRAP', 'SIGNALWRAP', 'STATWATCHER', 'TCPCONNECTWRAP',
  'TCPSERVERWRAP', 'TCPWRAP', 'TTYWRAP', 'UDPSENDWRAP', 'UDPWRAP', 'WRITEWRAP',
  'ZLIB', 'SSLCONNECTION', 'PBKDF2REQUEST', 'RANDOMBYTESREQUEST', 'TLSWRAP',
  'DNSCHANNEL',
]);

// ---------------------------------------------------------------------------
// Async hooks — track async resource types by asyncId so we can identify them
// in before/after/promiseResolve without relying on resource.constructor.name.
// ---------------------------------------------------------------------------

const asyncIdToType: Record<number, string> = {};
const asyncIdToResource: Record<number, { _onTimeout?: { name?: string }; promise?: unknown }> = {};

const init = (asyncId: number, type: string, triggerAsyncId: number, resource: unknown): void => {
  if (IGNORED_HOOK_TYPES.has(type)) return;

  asyncIdToType[asyncId] = type;
  asyncIdToResource[asyncId] = resource as typeof asyncIdToResource[number];

  if (type === 'PROMISE') {
    postEvent(Events.InitPromise(asyncId, triggerAsyncId));
  }
  if (type === 'Timeout') {
    const res = resource as { _onTimeout?: { name?: string } };
    const callbackName = res._onTimeout?.name ?? 'anonymous';
    postEvent(Events.InitTimeout(asyncId, callbackName));
  }
  if (type === 'Microtask') {
    postEvent(Events.InitMicrotask(asyncId, triggerAsyncId));
  }
};

const before = (asyncId: number): void => {
  const type = asyncIdToType[asyncId];
  if (!type) return;
  if (type === 'PROMISE') postEvent(Events.BeforePromise(asyncId));
  if (type === 'Timeout') postEvent(Events.BeforeTimeout(asyncId));
  if (type === 'Microtask') postEvent(Events.BeforeMicrotask(asyncId));
};

const after = (asyncId: number): void => {
  const type = asyncIdToType[asyncId];
  if (!type) return;
  if (type === 'PROMISE') postEvent(Events.AfterPromise(asyncId));
  if (type === 'Microtask') postEvent(Events.AfterMicrotask(asyncId));
};

const destroy = (asyncId: number): void => {
  delete asyncIdToType[asyncId];
  delete asyncIdToResource[asyncId];
};

const promiseResolve = (asyncId: number): void => {
  if (asyncIdToResource[asyncId] !== undefined) {
    postEvent(Events.ResolvePromise(asyncId));
  }
};

asyncHooks.createHook({ init, before, after, destroy, promiseResolve }).enable();

// ---------------------------------------------------------------------------
// Source instrumentation — replace falafel with @babel/traverse + @babel/generator
// ---------------------------------------------------------------------------

const instrumentFunctions = (sourceCode: string): string => {
  const ast = parse(sourceCode, {
    sourceType: 'script',
    allowReturnOutsideFunction: true,
    errorRecovery: true,
  });

  traverse(ast, {
    Function(path) {
      const node = path.node;
      const start = node.start ?? 0;
      const end = node.end ?? 0;

      // Derive the function name from the node or its parent context
      let fnName = 'anonymous';
      if ((t.isFunctionDeclaration(node) || t.isFunctionExpression(node)) && node.id) {
        fnName = node.id.name;
      } else {
        const parent = path.parent;
        if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) {
          fnName = parent.id.name;
        } else if (t.isAssignmentExpression(parent) && t.isIdentifier(parent.left)) {
          fnName = (parent.left as t.Identifier).name;
        } else if (t.isObjectProperty(parent) && t.isIdentifier(parent.key)) {
          fnName = (parent.key as t.Identifier).name;
        }
      }

      // Convert implicit-return arrow functions to block bodies so we can wrap them
      if (t.isArrowFunctionExpression(node) && !t.isBlockStatement(node.body)) {
        const returnStmt = t.returnStatement(node.body as t.Expression);
        node.body = t.blockStatement([returnStmt]);
      }

      if (!t.isBlockStatement(node.body)) return;

      const originalBody = [...node.body.body];

      // Build: const __tracerId = nextId();
      const idDecl = t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier('__tracerId'),
          t.callExpression(t.identifier('nextId'), []),
        ),
      ]);

      // Build: Tracer.enterFunc(__tracerId, 'fnName', start, end)
      const enterCall = t.expressionStatement(
        t.callExpression(
          t.memberExpression(t.identifier('Tracer'), t.identifier('enterFunc')),
          [
            t.identifier('__tracerId'),
            t.stringLiteral(fnName),
            t.numericLiteral(start),
            t.numericLiteral(end),
          ],
        ),
      );

      // Build try { <original body> } catch (__tracerErr) { ... } finally { exitFunc }
      const tryStmt = t.tryStatement(
        t.blockStatement(originalBody),
        t.catchClause(
          t.identifier('__tracerErr'),
          t.blockStatement([
            t.expressionStatement(
              t.callExpression(
                t.memberExpression(t.identifier('Tracer'), t.identifier('errorFunc')),
                [
                  t.memberExpression(
                    t.identifier('__tracerErr'),
                    t.identifier('message'),
                  ),
                  t.identifier('__tracerId'),
                  t.stringLiteral(fnName),
                  t.numericLiteral(start),
                  t.numericLiteral(end),
                ],
              ),
            ),
            t.throwStatement(t.identifier('__tracerErr')),
          ]),
        ),
        t.blockStatement([
          t.expressionStatement(
            t.callExpression(
              t.memberExpression(t.identifier('Tracer'), t.identifier('exitFunc')),
              [
                t.identifier('__tracerId'),
                t.stringLiteral(fnName),
                t.numericLiteral(start),
                t.numericLiteral(end),
              ],
            ),
          ),
        ]),
      );

      node.body.body = [idDecl, enterCall, tryStmt];
    },
  });

  return generate(ast, {}, sourceCode).code;
};

const instrumentLoops = (sourceCode: string): string => {
  const result = babel.transformSync(sourceCode, {
    plugins: [traceLoops],
    configFile: false,
    babelrc: false,
  });
  return result?.code ?? sourceCode;
};

// ---------------------------------------------------------------------------
// Tracer — functions injected into the vm sandbox
// ---------------------------------------------------------------------------

const START_TIME = Date.now();
const TIMEOUT_MILLIS = 5000;
const EVENT_LIMIT = 500;
const VM_TIMEOUT_MS = 6000;

let nextIdCounter = 0;
const nextId = (): number => nextIdCounter++;

const arrToPrettyStr = (args: unknown[]): string =>
  args.map((a) => (_.isString(a) ? a : prettyFormat(a))).join(' ') + '\n';

const Tracer = {
  enterFunc: (id: number, name: string, start: number, end: number): void => {
    postEvent(Events.EnterFunction(id, name, start, end));
  },
  exitFunc: (id: number, name: string, start: number, end: number): void => {
    postEvent(Events.ExitFunction(id, name, start, end));
  },
  errorFunc: (message: string, id: number, name: string, start: number, end: number): void => {
    postEvent(Events.ErrorFunction(message, id, name, start, end));
  },
  log: (...args: unknown[]): void => postEvent(Events.ConsoleLog(arrToPrettyStr(args))),
  warn: (...args: unknown[]): void => postEvent(Events.ConsoleWarn(arrToPrettyStr(args))),
  error: (...args: unknown[]): void => postEvent(Events.ConsoleError(arrToPrettyStr(args))),

  iterateLoop: (): void => {
    const timedOut = Date.now() - START_TIME > TIMEOUT_MILLIS;
    const limitReached = eventCount >= EVENT_LIMIT;
    if (timedOut || limitReached) {
      postEvent(
        Events.EarlyTermination(
          timedOut
            ? `Terminated early: Timeout of ${TIMEOUT_MILLIS}ms exceeded.`
            : `Terminated early: Event limit of ${EVENT_LIMIT} exceeded.`,
        ),
      );
      process.exit(1);
    }
  },
};

// ---------------------------------------------------------------------------
// Internal hard timeout — posts EarlyTermination and exits if async code hangs
// ---------------------------------------------------------------------------

setTimeout(() => {
  postEvent(Events.EarlyTermination(`Terminated early: Timeout of ${TIMEOUT_MILLIS}ms exceeded.`));
  process.exit(1);
}, TIMEOUT_MILLIS);

// ---------------------------------------------------------------------------
// Uncaught exception handler (e.g. call stack overflow)
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err: Error) => {
  postEvent(Events.UncaughtError(err));
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Instrument and execute the user's source code
// ---------------------------------------------------------------------------

const jsSourceCode = workerData as string;

let modifiedSource: string;
try {
  const withFunctions = instrumentFunctions(jsSourceCode);
  modifiedSource = instrumentLoops(withFunctions);
} catch (err) {
  postEvent(Events.UncaughtError(err instanceof Error ? err : new Error(String(err))));
  process.exit(1);
}

const sandbox = {
  nextId,
  Tracer,
  fetch,
  _,
  lodash: _,
  setTimeout,
  queueMicrotask,
  Promise,
  console: {
    log: Tracer.log,
    warn: Tracer.warn,
    error: Tracer.error,
  },
};

const context = vm.createContext(sandbox);

try {
  vm.runInContext(modifiedSource, context, { timeout: VM_TIMEOUT_MS });
} catch (err) {
  // vm timeout or runtime error not already caught by the uncaughtException handler
  postEvent(Events.UncaughtError(err instanceof Error ? err : new Error(String(err))));
  process.exit(1);
}
