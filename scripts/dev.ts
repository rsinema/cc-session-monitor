/**
 * Dev runner: spawns the Hono server (with --watch) and the Vite dev server side by side.
 * Vite proxies /api → :3737. Open http://localhost:5173.
 */
import { spawn } from "node:child_process";

function run(cmd: string, args: string[], label: string, color: string) {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const prefix = `\x1b[${color}m[${label}]\x1b[0m `;

  function pipe(stream: NodeJS.ReadableStream) {
    let buf = "";
    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length) process.stdout.write(prefix + line + "\n");
      }
    });
    stream.on("end", () => {
      if (buf) process.stdout.write(prefix + buf + "\n");
    });
  }

  pipe(p.stdout);
  pipe(p.stderr);

  p.on("exit", (code) => {
    process.stdout.write(prefix + `exited with code ${code}\n`);
    process.exit(code ?? 0);
  });
  return p;
}

const server = run("bun", ["--watch", "src/server.ts"], "server", "36"); // cyan
const web = run("bun", ["x", "vite", "--config", "web/vite.config.ts"], "web", "35"); // magenta

function shutdown() {
  server.kill();
  web.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
