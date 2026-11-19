// Chaos-test engine process: resumes one run with a scripted worker. The parent kills it with
// SIGKILL at random moments and starts it again until the run completes.
// Usage: node child.mjs <dataDir> <runId> <seed>
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AdapterRegistry, OPENAI_COMPATIBLE_MANIFEST, SessionController } from "@orzeus/providers";
import { createEngine, createJsonLogger } from "../../dist/index.js";

const [dataDir, runId, seedText] = process.argv.slice(2);
let seed = Number(seedText) >>> 0;
const random = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};

const worker = {
  manifest: OPENAI_COMPATIBLE_MANIFEST,
  probe: async () => ({ ok: true, version: "chaos", detail: "" }),
  listModels: async () => [],
  startSession(request) {
    const controller = new SessionController();
    void (async () => {
      await new Promise((r) => setTimeout(r, 30 + Math.floor(random() * 170)));
      const path = `out/${request.nodeId}.txt`;
      const decision = await controller.requestApproval(path, { kind: "file_write", path });
      if (decision.kind === "allow_once") {
        await mkdir(join(request.worktree.path, "out"), { recursive: true });
        await writeFile(join(request.worktree.path, path), `${request.nodeId}\n`);
      }
      controller.emit({
        type: "usage",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        costMicroUsd: 0,
      });
      controller.finish({
        status: "completed",
        summary: `wrote ${path}`,
        costMicroUsd: 0,
        resume: null,
        errorClass: null,
      });
    })();
    return controller.session({ onSteer: async () => undefined, onCancel: async () => undefined });
  },
};

const engine = createEngine({
  dataDir,
  logger: createJsonLogger(() => undefined),
  adapters: new AdapterRegistry().register(worker, {
    accountId: "chaos",
    label: "chaos",
    auth: { kind: "none" },
    getSecret: async () => "",
  }),
  gateway: false,
  lockTtlMs: 400,
  random,
});
const final = await engine.orchestrator.resume(runId);
process.stdout.write(`${JSON.stringify({ status: final.status })}\n`);
engine.close();
