import chokidar from "chokidar";

/**
 * Watch ~/.claude/projects/**\/*.jsonl and call `onChange(filePath)` whenever a session file
 * is created or modified. Single-flight per file: if a change arrives mid-ingest, we queue exactly
 * one follow-up so we don't lose updates and don't pile up parallel reads.
 */
export function startWatcher(rootDir: string, onChange: (filePath: string) => void) {
  const watcher = chokidar.watch(`${rootDir}/**/*.jsonl`, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    usePolling: false,
  });

  // path -> "running" | "queued" | undefined
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
        if (after === "queued") {
          // Re-fire once if we got an event mid-flight.
          handle(path);
        }
      }
    });
  };

  watcher.on("add", handle);
  watcher.on("change", handle);

  return () => watcher.close();
}
