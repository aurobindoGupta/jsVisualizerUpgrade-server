export type EventType =
  | 'EnterFunction'
  | 'ExitFunction'
  | 'ErrorFunction'
  | 'ConsoleLog'
  | 'ConsoleWarn'
  | 'ConsoleError'
  | 'InitPromise'
  | 'ResolvePromise'
  | 'BeforePromise'
  | 'AfterPromise'
  | 'InitMicrotask'
  | 'BeforeMicrotask'
  | 'AfterMicrotask'
  | 'InitTimeout'
  | 'BeforeTimeout'
  | 'EnqueueMicrotask'
  | 'DequeueMicrotask'
  | 'Rerender'
  | 'Done'
  | 'UncaughtError'
  | 'EarlyTermination';

export interface ExecutionEvent {
  type: EventType;
  payload: Record<string, unknown>;
}

export interface RunCodeMessage {
  type: 'RunCode';
  payload: string;
}
