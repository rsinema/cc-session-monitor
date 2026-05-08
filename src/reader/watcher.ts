import chokidar from "chokidar";

/**
 * Watch ~/.claude/projects/**\/*.jsonl. Per-file mutex with a single queued
 * follow-up so a long write firing many `change` events won't pile up reads.
 *
 * Crucially, no `awaitWriteFinish`: when Claude Code is mid-turn it writes
 * continuously, and a stability-threshold timer keeps resetting and never
 * fires — the session sits visibly stuck in AWAITING_USER until the entire
 * turn completes. Our tail (src/reader/tail.ts) already handles partial
 * trailing lines, so reading mid-write is safe: complete lines are emitted,
 * the partial last line stays buffered for next read.
 */
export function startWatcher(rootDir: string, onChange: (filePath: string) => void) {
  const watcher = chokidar.watch(`${rootDir}/**/*.jsonl`, {
    ignoreInitial: true,
    usePolling: false,
  });

  const state = new Map<string, "running" | "queued">();

  const handle = (path: string) => {
    const cur = state.get(path);
    if (cur === "running") {
      state.set(path, "queued");
      return;
    }
    state.set(path, "running");
    queueMicrotask(() => {
      try {
        onChange(path);
      } finally {
        const after = state.get(path);
        state.delete(path);
        if (after === "queued") handle(path);
      }
    });
  };

  watcher.on("add", handle);
  watcher.on("change", handle);

  return () => watcher.close();
}
