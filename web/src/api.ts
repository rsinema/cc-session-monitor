export interface Session {
  id: string;
  project_path: string;
  project_name: string;
  started_at: number;
  last_activity: number;
  message_count: number;
  file_path: string;
  awaiting_input: number;
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
    (await j<{ sessions: Session[] }>(await fetchSafe(`/api/sessions?limit=200`))).sessions,
  getSession: async (id: string): Promise<{ session: Session; messages: Message[] }> =>
    j(await fetchSafe(`/api/sessions/${id}`)),
  search: async (q: string): Promise<SearchResult[]> =>
    (await j<{ results: SearchResult[] }>(await fetchSafe(`/api/search?q=${encodeURIComponent(q)}`)))
      .results,
};

async function fetchSafe(url: string): Promise<Response> {
  return fetch(url, { credentials: "same-origin" });
}
