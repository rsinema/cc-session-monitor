import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ROOT = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));

// Short commit SHA for the build banner. Prefer APP_COMMIT (passed in via
// Docker build-arg from scripts/publish-image.sh, since `.git` is not COPYed
// into the image); fall back to a local `git rev-parse` for `vite dev` and
// host builds; final fallback "dev" when neither is available.
function shortCommit(): string {
  if (process.env.APP_COMMIT) return process.env.APP_COMMIT;
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}

export default defineConfig({
  root: resolve(__dirname),
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(shortCommit()),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3737",
        changeOrigin: true,
        ws: false,
      },
    },
  },
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
});
