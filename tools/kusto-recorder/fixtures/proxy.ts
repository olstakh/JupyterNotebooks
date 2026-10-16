import { Recorder } from "../recorder.js";
import { startProxy } from "../proxy.js";
import { join } from "node:path";

if (!process.env.RECORDER_TEST_ROOT) throw new Error("RECORDER_TEST_ROOT is required.");
await startProxy(new Recorder(process.env.RECORDER_TEST_ROOT, "integration"), {
  command: process.execPath, args: ["run", join(import.meta.dir, "upstream.ts")], stderr: "inherit",
});
