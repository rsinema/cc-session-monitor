/**
 * SSE event vocabulary for v2. Narrower and more meaningful than v1's
 * "session_updated" payload soup.
 */
import type { EventRow, SessionRow, SessionState, SessionSubState } from "../db.ts";

export type BusEvent =
  | {
      type: "event_appended";
      sessionId: string;
      event: EventRow;
    }
  | {
      type: "state_changed";
      sessionId: string;
      from: { state: SessionState; sub_state: SessionSubState } | null;
      to: { state: SessionState; sub_state: SessionSubState };
      currentToolUseId: string | null;
      ts: number;
    }
  | {
      type: "tool_started";
      sessionId: string;
      toolUseId: string;
      name: string;
      ts: number;
    }
  | {
      type: "tool_completed";
      sessionId: string;
      toolUseId: string;
      ts: number;
    }
  | {
      type: "session_meta";
      session: SessionRow;
    };

type Listener = (evt: BusEvent) => void;
const listeners = new Set<Listener>();

export function subscribeBus(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
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
