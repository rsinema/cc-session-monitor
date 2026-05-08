export type SessionState = "WORKING" | "AWAITING_USER" | "EXITED";
export type SessionSubState =
  | "tool_in_flight"
  | "streaming"
  | "subagent_running"
  | "permission_prompt"
  | "plan_approval"
  | "question"
  | "turn_complete"
  | null;

export type EventKind =
  | "user_text"
  | "user_tool_result"
  | "assistant_text"
  | "assistant_thinking"
  | "assistant_tool_use"
  | "exit"
  | "system_meta"
  | "permission_mode"
  | "ai_title"
  | "hook_notification"
  | "hook_stop"
  | "hook_subagent_stop";

export interface Session {
  id: string;
  project_path: string;
  project_name: string;
  title: string | null;
  file_path: string;
  started_at: number;
  /** Most recent ts of any event we ingested for this session, including noise (permission_mode, ai_title, system_meta, hook_*). */
  last_event_ts: number;
  /** Most recent ts of a "real" event (user/assistant/exit). What the UI should sort and bucket on. */
  last_real_event_ts: number;
  state: SessionState;
  sub_state: SessionSubState;
  state_since: number;
  current_tool_use_id: string | null;
  exited_at_event: number | null;
  hook_perm_prompt_at: number | null;
  current_permission_mode: string | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_create: number;
}

export interface SessionEvent {
  id: number;
  file_path: string;
  byte_offset: number;
  line_sha: string;
  session_id: string | null;
  kind: EventKind;
  ts: number;
  uuid: string | null;
  parent_uuid: string | null;
  tool_use_id: string | null;
  tool_result_id: string | null;
  is_sidechain: number;
  stop_reason: string | null;
  text_preview: string | null;
  raw: string;
}

export interface OpenTool {
  tool_use_id: string;
  session_id: string;
  name: string;
  started_at: number;
  completed_at: number | null;
  is_error: number | null;
  is_sidechain: number;
}

export interface SearchResult {
  id: number;
  session_id: string;
  kind: EventKind;
  ts: number;
  snippet: string;
  project_name: string;
  project_path: string;
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  listSessions: async (): Promise<Session[]> =>
    (await j<{ sessions: Session[] }>(await fetch(`/api/sessions?limit=200`))).sessions,

  getSession: async (
    id: string,
    opts?: { limit?: number }
  ): Promise<{
    session: Session;
    events: SessionEvent[];
    total: number;
    openTools: OpenTool[];
  }> => {
    const qs = opts?.limit ? `?limit=${opts.limit}` : "";
    return j(await fetch(`/api/sessions/${id}${qs}`));
  },

  getEarlierEvents: async (
    id: string,
    beforeTs: number,
    limit = 50
  ): Promise<SessionEvent[]> =>
    (
      await j<{ events: SessionEvent[] }>(
        await fetch(`/api/sessions/${id}/events?before_ts=${beforeTs}&limit=${limit}`)
      )
    ).events,

  search: async (q: string): Promise<SearchResult[]> =>
    (await j<{ results: SearchResult[] }>(await fetch(`/api/search?q=${encodeURIComponent(q)}`))).results,
};

/** Tag for a sub_state, used by the UI. Null = no sub-state (EXITED, etc.). */
export const SUB_STATE_LABEL: Record<NonNullable<SessionSubState>, string> = {
  tool_in_flight: "tool running",
  streaming: "thinking",
  subagent_running: "subagent",
  permission_prompt: "permission",
  plan_approval: "plan approval",
  question: "question",
  turn_complete: "turn done",
};
