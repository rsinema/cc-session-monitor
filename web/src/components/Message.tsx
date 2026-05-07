import { useState } from "react";
import type { Message } from "../api";
import { shortTime } from "../lib/format";

interface Props {
  message: Message;
}

export function MessageView({ message }: Props) {
  const [open, setOpen] = useState(false);

  const blocks = parseBlocks(message);

  const roleLabel =
    message.role === "user" ? "User" : message.role === "assistant" ? "Claude" : "System";

  const accent =
    message.role === "user"
      ? "border-emerald-500/40"
      : message.role === "assistant"
      ? "border-blue-500/40"
      : "border-zinc-700/60";

  return (
    <div className={`border-l-2 ${accent} pl-3 py-1`}>
      <div className="flex items-baseline justify-between text-xs text-zinc-500 mb-1">
        <span className="font-medium text-zinc-400">
          {roleLabel}
          {message.type !== "text" && (
            <span className="ml-2 text-[10px] uppercase tracking-wide text-zinc-600">
              {message.type}
            </span>
          )}
        </span>
        <span className="font-mono">{shortTime(message.timestamp)}</span>
      </div>
      <div className="space-y-2">
        {blocks.map((b, i) => (
          <BlockView key={i} block={b} open={open} onToggle={() => setOpen((o) => !o)} />
        ))}
      </div>
    </div>
  );
}

type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; name: string; input: unknown; id: string }
  | { kind: "tool_result"; toolUseId: string; content: string; isError?: boolean };

function parseBlocks(m: Message): Block[] {
  let parsed: any;
  try {
    parsed = JSON.parse(m.content);
  } catch {
    return [{ kind: "text", text: m.text_preview ?? "" }];
  }

  // Assistant message: array of blocks.
  if (m.role === "assistant" && Array.isArray(parsed)) {
    const out: Block[] = [];
    for (const b of parsed) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string") {
        out.push({ kind: "text", text: b.text });
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        out.push({ kind: "thinking", text: b.thinking });
      } else if (b.type === "tool_use") {
        out.push({ kind: "tool_use", name: b.name, input: b.input, id: b.id });
      }
    }
    return out;
  }

  // User message: string or array of tool_results.
  if (m.role === "user") {
    if (typeof parsed === "string") return [{ kind: "text", text: parsed }];
    if (Array.isArray(parsed)) {
      const out: Block[] = [];
      for (const b of parsed) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "tool_result") {
          const c = b.content;
          let text: string;
          if (typeof c === "string") text = c;
          else if (Array.isArray(c)) text = c.map((cb: any) => cb?.text ?? "").join("\n");
          else text = "";
          out.push({ kind: "tool_result", toolUseId: b.tool_use_id, content: text, isError: !!b.is_error });
        } else if (b.type === "text" && typeof b.text === "string") {
          out.push({ kind: "text", text: b.text });
        }
      }
      return out;
    }
  }

  return [{ kind: "text", text: m.text_preview ?? "" }];
}

const LONG_TEXT_CHARS = 1200;
const LONG_TEXT_LINES = 25;

function isLong(text: string): boolean {
  if (text.length > LONG_TEXT_CHARS) return true;
  let nl = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 && ++nl > LONG_TEXT_LINES) return true;
  }
  return false;
}

function CollapsibleText({
  text,
  className,
  open,
  onToggle,
}: {
  text: string;
  className: string;
  open: boolean;
  onToggle: () => void;
}) {
  if (!isLong(text)) {
    return <pre className={className}>{text}</pre>;
  }
  const preview = open ? text : truncatePreview(text);
  return (
    <div>
      <pre className={className}>{preview}</pre>
      <button
        onClick={onToggle}
        className="mt-1 text-[11px] text-zinc-500 hover:text-zinc-300"
      >
        {open ? "collapse" : `show full message (${text.length.toLocaleString()} chars)`}
      </button>
    </div>
  );
}

function truncatePreview(text: string): string {
  // Cap at LONG_TEXT_LINES lines OR LONG_TEXT_CHARS chars, whichever comes first.
  let lineCount = 0;
  let cutAt = -1;
  for (let i = 0; i < text.length && i < LONG_TEXT_CHARS; i++) {
    if (text.charCodeAt(i) === 10) {
      lineCount++;
      if (lineCount === LONG_TEXT_LINES) {
        cutAt = i;
        break;
      }
    }
  }
  if (cutAt === -1) cutAt = Math.min(LONG_TEXT_CHARS, text.length);
  return text.slice(0, cutAt) + "\n…";
}

function BlockView({ block, open, onToggle }: { block: Block; open: boolean; onToggle: () => void }) {
  if (block.kind === "text") {
    return (
      <CollapsibleText
        text={block.text}
        className="whitespace-pre-wrap break-words text-sm text-zinc-200 font-sans"
        open={open}
        onToggle={onToggle}
      />
    );
  }
  if (block.kind === "thinking") {
    return (
      <details className="text-sm">
        <summary className="text-zinc-500 italic cursor-pointer select-none">[thinking]</summary>
        <pre className="whitespace-pre-wrap break-words mt-1 text-zinc-400 font-sans">{block.text}</pre>
      </details>
    );
  }
  if (block.kind === "tool_use") {
    const inputStr = (() => {
      try {
        return JSON.stringify(block.input, null, 2);
      } catch {
        return "";
      }
    })();
    return (
      <details className="text-sm rounded border border-zinc-800 bg-zinc-900/50">
        <summary className="px-2 py-1 cursor-pointer select-none text-zinc-300">
          <span className="text-blue-400 font-mono">▶ {block.name}</span>
          <span className="text-zinc-600 ml-2 text-xs font-mono">{block.id.slice(0, 14)}</span>
        </summary>
        <pre className="px-3 py-2 whitespace-pre-wrap break-words text-xs text-zinc-400 font-mono border-t border-zinc-800/60">
          {inputStr}
        </pre>
      </details>
    );
  }
  if (block.kind === "tool_result") {
    const text = block.content;
    const truncated = text.length > 1500 && !open;
    const shown = truncated ? text.slice(0, 1500) + "\n…" : text;
    return (
      <div
        className={
          "text-sm rounded border border-zinc-800 " +
          (block.isError ? "bg-red-950/30" : "bg-zinc-900/40")
        }
      >
        <div className="px-2 py-1 text-xs text-zinc-500 font-mono flex justify-between">
          <span>← tool result {block.isError && <span className="text-red-400">(error)</span>}</span>
          {text.length > 1500 && (
            <button onClick={onToggle} className="text-zinc-400 hover:text-zinc-200">
              {open ? "collapse" : "expand"}
            </button>
          )}
        </div>
        <pre className="px-3 py-2 whitespace-pre-wrap break-words text-xs text-zinc-300 font-mono border-t border-zinc-800/60">
          {shown}
        </pre>
      </div>
    );
  }
  return null;
}
