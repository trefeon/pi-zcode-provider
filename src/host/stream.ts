/**
 * Structural implementation of the host's AssistantMessageEventStream.
 *
 * Keeps the plugin runnable from a linked package under both OMP and PI
 * with no runtime resolution of the host's internal classes.
 */

import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream } from "@oh-my-pi/pi-ai";

/**
 * Drift tripwire: extensions/index.ts must cast this structural stream to the host's
 * AssistantMessageEventStream class (private fields defeat structural assignability).
 * If the host class ever stops satisfying this interface, the cast becomes unsound —
 * this compile-time check fails first, before any runtime surprise.
 */
type HostStreamConformance = AssistantMessageEventStream extends AssistantEventStream
  ? true
  : "AssistantMessageEventStream no longer satisfies AssistantEventStream — fix the cast in extensions/index.ts";
// Value exists to force the compile-time conformance check to evaluate.
const _HOST_STREAM_CONFORMANCE: HostStreamConformance = true;

export interface AssistantEventStream extends AsyncIterable<AssistantMessageEvent> {
  push(event: AssistantMessageEvent): void;
  /** Close the stream; without a final message result() rejects. */
  end(result?: AssistantMessage): void;
  fail(error: unknown): void;
  result(): Promise<AssistantMessage>;
  readonly hasPendingLocalWork: boolean;
  readonly localWorkSettledAt: number;
  trackLocalWork<TWork>(work: Promise<TWork>): Promise<TWork>;
  forwardLocalWorkFrom(source: AssistantEventStream | undefined): void;
}

interface Waiter {
  resolve: (value: IteratorResult<AssistantMessageEvent>) => void;
  reject: (error: unknown) => void;
}

function terminalResult(event: AssistantMessageEvent): AssistantMessage | null {
  if (event.type === "done") return event.message;
  if (event.type === "error") return event.error;
  return null;
}

export function createAssistantEventStream(): AssistantEventStream {
  const queue: AssistantMessageEvent[] = [];
  const waiters: Waiter[] = [];
  let done = false;
  let failure: unknown;
  let resultSettled = false;
  let pendingLocalWork = 0;
  let settledAt = 0;
  let delegate: AssistantEventStream | undefined;

  const { promise: finalResult, resolve: rawResolve, reject: rawReject } = Promise.withResolvers<AssistantMessage>();
  const resolveResult = (value: AssistantMessage): void => {
    if (resultSettled) return;
    resultSettled = true;
    rawResolve(value);
  };
  const rejectResult = (error: unknown): void => {
    if (resultSettled) return;
    resultSettled = true;
    rawReject(error);
  };
  finalResult.catch(() => {});
  const deliver = (event: AssistantMessageEvent): void => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve({ value: event, done: false });
    else queue.push(event);
  };

  return {
    push(event: AssistantMessageEvent): void {
      if (done) return;
      const result = terminalResult(event);
      if (result) {
        done = true;
        resolveResult(result);
      }
      deliver(event);
    },
    end(result?: AssistantMessage): void {
      if (done) return;
      done = true;
      if (result !== undefined) resolveResult(result);
      else if (!resultSettled) rejectResult(new Error("ZCode stream ended without a final result"));
      for (const waiter of waiters.splice(0)) {
        waiter.resolve({ value: undefined, done: true });
      }
    },
    fail(error: unknown): void {
      if (done) return;
      done = true;
      failure = error;
      for (const waiter of waiters.splice(0)) waiter.reject(error);
      rejectResult(error);
    },
    async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
      for (;;) {
        const queued = queue.shift();
        if (queued) {
          yield queued;
          continue;
        }
        if (done) {
          if (failure !== undefined) throw failure;
          return;
        }
        const { promise, resolve, reject } = Promise.withResolvers<IteratorResult<AssistantMessageEvent>>();
        waiters.push({ resolve, reject });
        const event = await promise;
        if (event.done) {
          if (failure !== undefined) throw failure;
          return;
        }
        yield event.value;
      }
    },
    result(): Promise<AssistantMessage> {
      return finalResult;
    },
    get hasPendingLocalWork(): boolean {
      return pendingLocalWork > 0 || (delegate?.hasPendingLocalWork ?? false);
    },
    get localWorkSettledAt(): number {
      return Math.max(settledAt, delegate?.localWorkSettledAt ?? 0);
    },
    trackLocalWork<TWork>(work: Promise<TWork>): Promise<TWork> {
      pendingLocalWork += 1;
      return work.finally(() => {
        pendingLocalWork -= 1;
        settledAt = Date.now();
      });
    },
    forwardLocalWorkFrom(source: AssistantEventStream | undefined): void {
      delegate = source;
    },
  };
}
