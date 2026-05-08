/**
 * Tiny in-process pub/sub for SSE broadcasts. Single-process app, so this is enough.
 */
type Listener = (evt: BusEvent) => void;

export type BusEvent =
  | { type: "message"; sessionId: string; message: any }
  | { type: "session_updated"; session: any }
  | { type: "awaiting_input"; sessionId: string; awaitingInput: boolean };

const listeners = new Set<Listener>();

export function subscribeBus(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function publish(evt: BusEvent) {
  for (const fn of listeners) {
    try {
      fn(evt);
    } catch {
      // ignore listener crashes
    }
  }
}
