import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
if (!existsSync(resolve(root, "node_modules", "@modelcontextprotocol", "sdk", "package.json"))) {
  console.error("Installing pinned Kusto recorder dependencies...");
  const install = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile"], {
    cwd: root, stdout: "pipe", stderr: "inherit", stdin: "ignore",
  });
  if (install.stdout.length) process.stderr.write(install.stdout);
  if (install.exitCode !== 0) {
    console.error("Recorder dependency installation failed.");
    process.exit(install.exitCode || 1);
  }
}
await import("./index.js");
