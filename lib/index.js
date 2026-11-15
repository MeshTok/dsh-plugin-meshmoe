// ============================================================================
// dsh-meshmoe — MeshMoe runtime provider for DeepSeek Harness
//
// What it does, all locally and with no account:
//   1. Ensures the MeshMoe-4B model server is up on 127.0.0.1:8081
//      (spawns llama-server.exe from the MeshMoe runtime when it is not).
//   2. Merges the meshmoe-local provider into the user's existing DSH
//      configuration so no other provider is overwritten.
//   3. Joins the MeshMoe compute mesh: starts edge_node.py against the local
//      model and reports accumulated Joules periodically.
//
// Design notes:
//   * Everything is best-effort. If the MeshMoe runtime is not installed the
//     plugin stays quiet and tells the user where to get it; it never throws
//     into the harness boot path.
//   * All resources are registered through ctx.effect / ctx.on with cleanup.
// ============================================================================

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { mergePatch } from "./merge.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  llamaPort: 8081,
  edgeNodePort: 4002,
  autostartModel: true,
  joinMesh: true,
};

const RETRY_MAX = 15;
const RETRY_INTERVAL_MS = 2000;
const HONOR_POLL_MS = 5 * 60 * 1000;

/** Resolve the MeshMoe runtime directory (holds llama-bin/ and models/). */
function findRuntimeRoot() {
  const explicit = process.env.MESHMOE_RUNTIME_ROOT;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    path.join(local, "MeshMoe", "runtime"),
    path.join(process.env.PROGRAMFILES || "C:\\Program Files", "MeshMoe", "runtime"),
    "D:\\meshmoe\\dsh-integration\\runtime",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Locate edge_node.py from the installed node package or a checkout. */
function findEdgeNodeScript() {
  const explicit = process.env.MESHMOE_NODE_SCRIPT;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    path.join(local, "MeshMoe", "node", "edge_node.py"),
    path.join(HERE, "..", "..", "node", "edge_node.py"),
    "D:\\meshmoe\\node\\edge_node.py",
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** A bundled Python is shipped by the node installer; fall back to PATH. */
function findPython(runtimeRoot) {
  const candidates = [
    process.env.MESHMOE_PYTHON,
    runtimeRoot && path.join(runtimeRoot, "..", "python", "python.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "MeshMoe", "python", "python.exe"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "python";
}

function fetchJson(port, requestPath, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: requestPath, timeout: timeoutMs }, (res) => {
      let buf = "";
      res.on("data", (chunk) => (buf += chunk));
      res.on("end", () => {
        try {
          resolve({ ok: res.statusCode === 200, data: JSON.parse(buf) });
        } catch {
          resolve({ ok: res.statusCode === 200, data: null });
        }
      });
    });
    req.on("error", () => resolve({ ok: false, data: null }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, data: null });
    });
  });
}

/** llama-server exposes /v1/models, not /health. */
function modelServerUp(port) {
  return fetchJson(port, "/v1/models").then((r) => r.ok);
}

async function waitForModelServer(port, tries) {
  for (let i = 0; i < tries; i += 1) {
    if (await modelServerUp(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
  }
  return false;
}

function startModelServer(runtimeRoot, port) {
  const exe = path.join(runtimeRoot, "llama-bin", "llama-server.exe");
  const modelsDir = path.join(runtimeRoot, "models");
  // Prefer the sharded layout produced by the installer, else the single file.
  const sharded = path.join(modelsDir, "MeshMoe-4B-00001-of-00002.gguf");
  const single = path.join(modelsDir, "MeshMoe-4B-Q4_K_M.gguf");
  const model = fs.existsSync(sharded) ? sharded : single;

  if (!fs.existsSync(exe) || !fs.existsSync(model)) {
    return {
      started: false,
      error: `runtime incomplete (exe=${fs.existsSync(exe)}, model=${fs.existsSync(model)})`,
    };
  }

  const args = [
    "-m", model,
    "--port", String(port),
    "--host", "127.0.0.1",
    "--jinja",
    "-c", "32768",
    "--reasoning-budget", "0",
  ];
  // CPU-only machines: MESHMOE_NO_GPU=1 keeps llama.cpp off the GPU.
  if (process.env.MESHMOE_NO_GPU !== "1") args.push("-ngl", "99");

  const child = spawn(exe, args, { stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  return { started: true, child };
}

function startEdgeNode(script, runtimeRoot, config) {
  const python = findPython(runtimeRoot);
  const env = {
    ...process.env,
    MESHMOE_CONNECTOR_URL: `http://127.0.0.1:${config.llamaPort}`,
    MESHMOE_MODEL: "MeshMoe-4B-Q4_K_M",
    MESHMOE_PORT: String(config.edgeNodePort),
    MESHMOE_NODE_ID: process.env.MESHMOE_NODE_ID || os.hostname(),
    PYTHONUNBUFFERED: "1",
  };
  const child = spawn(python, ["-u", script], { env, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  return child;
}

export const name = "dsh-meshmoe";

export const Config = z.object({
  llamaPort: z.number().default(DEFAULTS.llamaPort).description("Port of the local llama-server."),
  edgeNodePort: z.number().default(DEFAULTS.edgeNodePort).description("Port of the local edge node health server."),
  autostartModel: z.boolean().default(DEFAULTS.autostartModel).description("Start llama-server when it is not already running."),
  joinMesh: z.boolean().default(DEFAULTS.joinMesh).description("Start the edge node so this machine joins the mesh."),
});

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config };
  const log = (message) => {
    try {
      ctx.logger?.info?.(`[meshmoe] ${message}`);
    } catch {
      console.log(`[meshmoe] ${message}`);
    }
  };

  // ---- 1. Merge our provider into the user's patch (never overwrite) ----
  ctx.effect(() => {
    try {
      const userPatch = path.join(os.homedir(), ".dsh", "profiles", "desktop", "cordis.patch.yml");
      const ourPatch = path.join(HERE, "..", "cordis.patch.yml");
      const runtimeRoot = findRuntimeRoot();
      const out = runtimeRoot
        ? path.join(runtimeRoot, "meshmoe-merged.patch.yml")
        : path.join(os.tmpdir(), "meshmoe-merged.patch.yml");
      const merged = mergePatch(userPatch, ourPatch, out, {
        baseURL: `http://127.0.0.1:${settings.llamaPort}/v1`,
      });
      log(merged ? `provider merged into user config -> ${merged}` : "using built-in provider patch");
    } catch (error) {
      log(`patch merge skipped (non-fatal): ${error.message}`);
    }
  }, "meshmoe: merge provider into user config");

  // ---- 2. Ensure the local model server ----
  ctx.effect(async () => {
    if (await modelServerUp(settings.llamaPort)) {
      log(`model server already up on :${settings.llamaPort}`);
      return;
    }
    if (!settings.autostartModel) {
      log(`model server not running and autostartModel is off`);
      return;
    }
    const runtimeRoot = findRuntimeRoot();
    if (!runtimeRoot) {
      log("MeshMoe runtime not found; install the MeshMoe node package or set MESHMOE_RUNTIME_ROOT");
      return;
    }
    const result = startModelServer(runtimeRoot, settings.llamaPort);
    if (!result.started) {
      log(`could not start model server: ${result.error}`);
      return;
    }
    if (ctx.onDispose) {
      ctx.onDispose(() => {
        try {
          result.child.kill();
        } catch {
          /* already gone */
        }
      });
    }
    const ready = await waitForModelServer(settings.llamaPort, RETRY_MAX);
    log(ready ? `MeshMoe-4B ready on :${settings.llamaPort}` : "model server did not become ready in time");
  }, "meshmoe: ensure local model server");

  // ---- 3. Join the mesh and report honor ----
  ctx.effect(async () => {
    if (!settings.joinMesh) {
      log("joinMesh is off; this machine will not contribute compute");
      return;
    }
    if ((await fetchJson(settings.edgeNodePort, "/health")).ok) {
      log(`mesh node already online on :${settings.edgeNodePort}`);
      return;
    }
    const script = findEdgeNodeScript();
    if (!script) {
      log(
        "edge node not installed; the local model still works. Install MeshMoe-Node-Setup.exe " +
          "or set MESHMOE_NODE_SCRIPT to join the mesh.",
      );
      return;
    }
    // Give the model server a moment first so the node picks up connector mode.
    await waitForModelServer(settings.llamaPort, 5);
    log(`joining mesh via ${script}`);
    const child = startEdgeNode(script, findRuntimeRoot(), settings);
    if (ctx.onDispose) {
      ctx.onDispose(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const health = await fetchJson(settings.edgeNodePort, "/health");
    log(
      health.ok && health.data
        ? `mesh node online (auth=${health.data.authenticated ? "yes" : "pending"}, ` +
            `joules=${health.data.joules_earned ?? 0})`
        : "mesh node starting; check the node log if it does not appear",
    );
  }, "meshmoe: join mesh");

  // ---- 4. Periodic honor report ----
  ctx.effect(() => {
    const timer = setInterval(async () => {
      const health = await fetchJson(settings.edgeNodePort, "/health");
      if (!health.ok || !health.data) return;
      const d = health.data;
      log(
        `honor: ${d.joules_earned ?? 0} J burned | ${d.tasks_processed ?? 0} tasks | ` +
          `auth=${d.authenticated ? "yes" : "no token"}`,
      );
    }, HONOR_POLL_MS);
    return () => clearInterval(timer);
  }, "meshmoe: honor poller");
}

export default { name, Config, apply };
