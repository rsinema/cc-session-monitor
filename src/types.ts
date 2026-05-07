export type MessageRole = "user" | "assistant" | "system";

export type MessageType =
  | "text"
  | "tool_use"
  | "tool_result"
  | "thinking"
  | "system";

/** Output of parser.parseLine. One JSONL line may produce zero or one ParsedEvent. */
export interface ParsedEvent {
  /** message uuid (PK in DB). */
  id: string;
  sessionId: string;
  parentId: string | null;
  role: MessageRole;
  type: MessageType;
  /** Raw JSON of message.content (or attachment) — re-stringified for storage. */
  content: string;
  /** Flattened plain-text used for FTS / list previews. */
  textPreview: string;
  /** Unix ms. */
  timestamp: number;
  /** cwd from envelope, used to bootstrap the session row. */
  projectPath: string | null;
  /** True if this is a tool_use call (assistant) — useful for UI badges. */
  isToolUse?: boolean;
  /** Tool name, when type === "tool_use". */
  toolName?: string;
}

export interface SessionRow {
  id: string;
  project_path: string;
  project_name: string;
  started_at: number;
  last_activity: number;
  message_count: number;
  file_path: string;
  awaiting_input: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  parent_id: string | null;
  role: MessageRole;
  type: MessageType;
  content: string;
  text_preview: string | null;
  timestamp: number;
  line_number: number;
}
