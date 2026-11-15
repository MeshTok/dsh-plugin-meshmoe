# MeshMoe local model

Adds a free, local, keyless model to DeepSeek Harness and lets this machine contribute idle compute to the MeshMoe network.

## What you get

- **A local model provider** named `meshmoe-local`, serving MeshMoe-4B (Q4_K_M, 2.7 GB, 32K context) from `llama-server` on `127.0.0.1:8081`. No account, no API key, no network call for inference — it runs on your hardware and works offline.
- **Tool calling** is enabled (`--jinja`) with thinking disabled for fast agent loops.
- **Your existing setup is preserved.** The plugin merges its provider into your configuration; other providers and your chosen default model are left alone unless you had none.

## What it does in the background

- Starts `llama-server` if it is not already running.
- Starts the MeshMoe edge node so the machine joins the compute mesh and serves occasional tasks for other users. Contribution is metered in **Joules** (`J = GPU power × time`), recorded in an append-only public ledger. Joules are honor: not currency, not transferable, not redeemable.
- Reports the running total in the plugin log every five minutes.

## Requirements

| Component | Notes |
|---|---|
| MeshMoe node package | Provides `llama-server.exe`, the model, and `edge_node.py`. Install it first, or set `MESHMOE_RUNTIME_ROOT` / `MESHMOE_NODE_SCRIPT`. |
| DSH | Built against `0.2.2-rc.1`. |
| Hardware | ~4 GB RAM for CPU-only; an NVIDIA GPU makes it much faster. |

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `llamaPort` | `8081` | Port of the local model server. |
| `edgeNodePort` | `4002` | Port of the edge node health endpoint. |
| `autostartModel` | `true` | Start `llama-server` when it is not running. |
| `joinMesh` | `true` | Join the mesh and earn Joules. Set `false` to use the model locally only. |

Environment overrides: `MESHMOE_RUNTIME_ROOT`, `MESHMOE_NODE_SCRIPT`, `MESHMOE_PYTHON`, `MESHMOE_NO_GPU=1` (force CPU), `MESHMOE_NODE_ID`.

## Limitations

- Inference quality is that of a 4B model. It is good at tool use and short agent loops, not at long-form reasoning.
- The mesh features need the separate node package; without it the plugin only provides the local model and logs where to get the node installer.
- Joining the mesh is voluntary and on by default. Turn `joinMesh` off if you do not want to contribute compute.

## Verify it worked

1. The plugin log reports `MeshMoe-4B ready on :8081`.
2. Pick `MeshMoe-4B (Q4_K_M)` as the model in a new session and send a prompt.
3. `http://127.0.0.1:4002/health` shows `authenticated: true` once the node has registered.
