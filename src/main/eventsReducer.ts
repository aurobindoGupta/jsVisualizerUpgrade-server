import type { EventType, ExecutionEvent } from '../types/events';

interface ReducerState {
  events: ExecutionEvent[];
  parentsIdsOfPromisesWithInvokedCallbacks: Array<{ id: number; name: string }>;
  parentsIdsOfMicrotasks: Array<{ id: number; name: string }>;
  prevEvt: Partial<ExecutionEvent>;
}

const makeEvent = (type: EventType, payload: Record<string, unknown> = {}): ExecutionEvent => ({
  type,
  payload,
});

const eventsReducer = (state: ReducerState, evt: ExecutionEvent): ReducerState => {
  const { type, payload } = evt;

  if (type === 'EarlyTermination') state.events.push(evt);
  if (type === 'UncaughtError') state.events.push(evt);

  if (type === 'ConsoleLog') state.events.push(evt);
  if (type === 'ConsoleWarn') state.events.push(evt);
  if (type === 'ConsoleError') state.events.push(evt);

  if (type === 'EnterFunction') {
    if (state.prevEvt.type === 'BeforePromise') {
      state.events.push(makeEvent('DequeueMicrotask'));
    }
    if (state.prevEvt.type === 'BeforeMicrotask') {
      state.events.push(makeEvent('DequeueMicrotask'));
    }
    state.events.push(evt);
  }
  if (type === 'ExitFunction') state.events.push(evt);
  if (type === 'ErrorFunction') state.events.push(evt);

  if (type === 'InitPromise') state.events.push(evt);
  if (type === 'ResolvePromise') {
    state.events.push(evt);

    const microtaskInfo = state.parentsIdsOfPromisesWithInvokedCallbacks.find(
      ({ id }) => id === (payload.id as number),
    );

    if (microtaskInfo) {
      state.events.push(makeEvent('EnqueueMicrotask', { name: microtaskInfo.name }));
    }
  }
  if (type === 'BeforePromise') state.events.push(evt);
  if (type === 'AfterPromise') state.events.push(evt);

  if (type === 'InitMicrotask') {
    state.events.push(evt);

    const microtaskInfo = state.parentsIdsOfMicrotasks.find(
      ({ id }) => id === (payload.id as number),
    );

    if (microtaskInfo) {
      state.events.push(makeEvent('EnqueueMicrotask', { name: microtaskInfo.name }));
    }
  }
  if (type === 'BeforeMicrotask') state.events.push(evt);
  if (type === 'AfterMicrotask') state.events.push(evt);

  if (type === 'InitTimeout') state.events.push(evt);
  if (type === 'BeforeTimeout') {
    state.events.push(makeEvent('Rerender'));
    state.events.push(evt);
  }

  state.prevEvt = evt;
  return state;
};

export const reduceEvents = (events: ExecutionEvent[]): ExecutionEvent[] => {
  // Certain Promises (e.g. from `fetch` calls) resolve multiple times.
  // Keep only the last occurrence per promise id to avoid confusing the view layer.
  const reversedOnce = [...events].reverse();
  const seenResolveIds = new Set<number>();
  const dedupedReverse = reversedOnce.filter((evt) => {
    if (evt.type !== 'ResolvePromise') return true;
    const id = evt.payload.id as number;
    if (seenResolveIds.has(id)) return false;
    seenResolveIds.add(id);
    return true;
  });
  events = dedupedReverse.reverse();

  // Determine when Microtasks were enqueued.
  // A Microtask was enqueued when its parent resolved iff the child Promise of the
  // parent had its callback invoked.
  // A Promise has its callback invoked iff a function was entered immediately after
  // the Promise's `BeforePromise` event.

  const filteredForPromises = events.filter(({ type }) =>
    (['BeforePromise', 'EnterFunction', 'ExitFunction', 'ResolvePromise'] as EventType[]).includes(
      type,
    ),
  );

  const promisesWithInvokedCallbacksInfo = filteredForPromises
    .map((evt, idx, arr) =>
      evt.type === 'BeforePromise' && (arr[idx + 1] ?? {}).type === 'EnterFunction'
        ? [evt, arr[idx + 1]]
        : undefined,
    )
    .filter((pair): pair is [ExecutionEvent, ExecutionEvent] => pair !== undefined)
    .map(([beforePromiseEvt, enterFunctionEvt]) => ({
      id: beforePromiseEvt.payload.id as number,
      name: enterFunctionEvt.payload.name as string,
    }));

  const promiseChildIdToParentId: Record<number, number> = {};
  events
    .filter(({ type }) => type === 'InitPromise')
    .forEach(({ payload: { id, parentId } }) => {
      promiseChildIdToParentId[id as number] = parentId as number;
    });

  const parentsIdsOfPromisesWithInvokedCallbacks = promisesWithInvokedCallbacksInfo.map(
    ({ id: childId, name }) => ({
      id: promiseChildIdToParentId[childId],
      name,
    }),
  );

  const filteredForMicrotasks = events.filter(({ type }) =>
    (
      [
        'InitMicrotask',
        'BeforeMicrotask',
        'AfterMicrotask',
        'EnterFunction',
        'ExitFunction',
      ] as EventType[]
    ).includes(type),
  );

  const microtasksWithInvokedCallbacksInfo = filteredForMicrotasks
    .map((evt, idx, arr) =>
      evt.type === 'BeforeMicrotask' && (arr[idx + 1] ?? {}).type === 'EnterFunction'
        ? [evt, arr[idx + 1]]
        : undefined,
    )
    .filter((pair): pair is [ExecutionEvent, ExecutionEvent] => pair !== undefined)
    .map(([beforeMicrotaskEvt, enterFunctionEvt]) => ({
      id: beforeMicrotaskEvt.payload.id as number,
      name: enterFunctionEvt.payload.name as string,
    }));

  const microtaskChildIdToParentId: Record<number, number> = {};
  events
    .filter(({ type }) => type === 'InitMicrotask')
    .forEach(({ payload: { id, parentId } }) => {
      microtaskChildIdToParentId[id as number] = parentId as number;
    });

  const parentsIdsOfMicrotasks = microtasksWithInvokedCallbacksInfo.map(
    ({ id: childId, name }) => ({
      id: microtaskChildIdToParentId[childId],
      name,
    }),
  );

  return events.reduce(eventsReducer, {
    events: [],
    parentsIdsOfPromisesWithInvokedCallbacks,
    parentsIdsOfMicrotasks,
    prevEvt: {},
  }).events;
};
