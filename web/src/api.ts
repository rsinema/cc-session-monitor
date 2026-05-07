export interface Session {
  id: string;
  project_path: string;
  project_name: string;
  started_at: number;
  last_activity: number;
  message_count: number;
  file_path: string;
  awaiting_input: number;
  // Joined from latest message; may be null for empty sessions.
  latest_role?: string | null;
  latest_type?: string | null;
  latest_preview?: string | null;
  latest_ts?: number | null;
}

export interface Message {
  id: string;
  session_id: string;
  parent_id: string | null;
  role: "user" | "assistant" | "system";
  type: "text" | "tool_use" | "tool_result" | "thinking" | "system";
  content: string;
  text_preview: string | null;
  timestamp: number;
  line_number: number;
}

export interface SearchResult {
  id: string;
  session_id: string;
  role: string;
  type: string;
  timestamp: number;
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

  /**
   * Load a session. With `limit` set, returns only the most recent N messages plus the total count
   * so the UI can show "N of M" and offer a "load earlier" expander.
   */
  getSession: async (
    id: string,
    opts?: { limit?: number }
  ): Promise<{ session: Session; messages: Message[]; total?: number }> => {
    const qs = opts?.limit ? `?limit=${opts.limit}` : "";
    return j(await fetch(`/api/sessions/${id}${qs}`));
  },

  /** Cursor-paginated history: messages strictly before `before_ts`, returned in chronological order. */
  getEarlierMessages: async (
    id: string,
    beforeTs: number,
    limit = 50
  ): Promise<Message[]> =>
    (
      await j<{ messages: Message[] }>(
        await fetch(`/api/sessions/${id}/messages?before_ts=${beforeTs}&limit=${limit}`)
      )
    ).messages,

  search: async (q: string): Promise<SearchResult[]> =>
    (await j<{ results: SearchResult[] }>(await fetch(`/api/search?q=${encodeURIComponent(q)}`)))
      .results,
};
