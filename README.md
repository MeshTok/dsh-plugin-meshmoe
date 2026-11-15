# dsh-plugin-meshmoe

MeshMoe for [DeepSeek Harness (DSH)](https://www.deepseek.com/) — run a local **MeshMoe-4B** agent with **zero registration, zero API keys, zero cost**, and your machine automatically joins the MeshMoe compute network as a specialist node.

> Turn your idle compute into community memory.

## What it does

- **Local model, no cloud**: wires DSH to a local `llama-server` running MeshMoe-4B (Q4_K_M, ~2.7 GB) via an OpenAI-compatible endpoint — free function-calling agent on your own hardware.
- **Zero-registration auth**: the plugin provisions a node token automatically. You never create an account; an anonymous node identity is bound to your machine, claimable later from meshmoe.com.
- **Honor, not payments**: every mesh task your GPU serves is metered in **Joules** (`J = power × time`, e.g. RTX 3050 @ 80 W × 30 s ≈ 2400 J). Joules are an append-only honor ledger — they can't be bought, sold, or exchanged.
- **Non-invasive config merge**: your existing DSH providers and default model are preserved. The plugin only *adds* a `meshmoe-local` provider; it never takes over your setup.
- **Auto-join the mesh**: on load the plugin starts the bundled edge node (if the MeshMoe Node package is installed), pointing it at the local model server. Anonymous registration and Joule metering happen with no user action. If only the plugin is installed (no node package), the local model still works and the plugin logs where to get the node installer.
- **Honor poller**: reports accumulated Joules from the node's `/health` every 5 minutes.

## Install

```bash
# inside your DSH installation
dsh plugin install dsh-plugin-meshmoe
```

Or clone and link manually:

```bash
git clone https://github.com/MeshTok/dsh-plugin-meshmoe.git
cd dsh-plugin-meshmoe
npm install
dsh plugin link .
```

## Requirements

| Component | Notes |
|---|---|
| DSH (DeepSeek Harness) | tested against `0.2.2-rc.1` |
| MeshMoe-4B GGUF | `MeshMoe-4B-Q4_K_M.gguf` — see https://meshmoe.com |
| llama.cpp ≥ b12340 | needs `--jinja` tool-calling support |
| ~4 GB RAM/VRAM | Q4_K_M fits a GTX 1650 / 8 GB RAM laptop |

## Configuration

`cordis.patch.yml` ships sensible defaults:

```yaml
providers:
  meshmoe-local:
    api: openai-completions
    baseURL: http://127.0.0.1:8081/v1
    apiKeyEnv: MESHMOE_LOCAL_KEY   # any non-empty value works
models:
  meshmoe-4b:
    provider: meshmoe-local
```

Start the runtime (or let the MeshMoe client do it):

```bash
llama-server -m MeshMoe-4B-Q4_K_M.gguf --jinja -c 32768 --reasoning-budget 0 --port 8081
```

## How the honor system works

```
you install → node registers anonymously → GPU serves mesh tasks
     → J = GPU power (W) × inference time (s)
     → append-only Joule ledger on meshmoe.com → claim your node any time
```

Measured baseline on consumer GPUs: **95.8% function-calling accuracy, ~45 tok/s** on RTX 3050-class hardware.

## License

Apache-2.0
