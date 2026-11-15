// ============================================================================
// dsh-meshmoe merge.js — merge our provider into the user's patch
//
// Why: a DSH patch row replaces the whole `config` of the row it matches. If a
// user already configured providers in the GUI, naively applying our patch
// would drop them. This module reads the user's patch, folds our
// meshmoe-local provider into their llm-pi-ai row (keeping every other
// provider), and writes a merged patch that the loader can apply.
//
// Handles both patch shapes found in DSH profiles:
//   * a flat list of rows              [{ id, name, config }]
//   * a list of `insert` wrappers      [{ insert: [{ id, name, config }] }]
// The merged output always uses the flat list form.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const LLM_PLUGIN_NAME = "@deepseek-ai/dsh-llm-pi-ai";
const DEFAULT_MODEL_PLUGIN_NAME = "@deepseek-ai/dsh-agent-default-model";

/**
 * The provider we contribute. It lives here, not in cordis.patch.yml, because
 * a patch row replaces the whole `config` of the row it targets — declaring
 * llm-pi-ai in the patch would wipe every provider the user already has.
 * `${baseURL}` is substituted by the caller.
 */
export function meshMoeProvider(baseURL = "http://127.0.0.1:8081/v1") {
  return {
    "meshmoe-local": {
      displayName: "MeshMoe (local)",
      api: "openai-completions",
      baseURL,
      apiKeyEnv: "MESHMOE_LOCAL_KEY",
      compat: { thinkingFormat: "deepseek" },
      models: [
        {
          id: "meshmoe-4b",
          name: "MeshMoe-4B (Q4_K_M)",
          reasoning: false,
          input: ["text"],
          contextWindow: 32768,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    },
  };
}

/** Flatten `{ insert: [...] }` wrappers into a plain row list. */
function flattenRows(patch) {
  if (!Array.isArray(patch)) return [];
  const rows = [];
  for (const entry of patch) {
    if (!entry || typeof entry !== "object") continue;
    if (Array.isArray(entry.insert)) rows.push(...entry.insert.filter((r) => r && typeof r === "object"));
    else if (entry.id || entry.name) rows.push(entry);
  }
  return rows;
}

function readPatch(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return flattenRows(YAML.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null; // a corrupted user patch must never block startup
  }
}

/**
 * Merge the MeshMoe provider into the user's existing patch.
 * @param {string} userPatchPath  may not exist (fresh profile)
 * @param {string} ourPatchPath   our cordis.patch.yml (contributes non-provider rows)
 * @param {string} outPath        where to write the merged result
 * @param {object} [options]
 * @param {string} [options.baseURL]  local model endpoint for the provider
 * @returns {string|null} merged file path, or null when nothing could be merged
 */
export function mergePatch(userPatchPath, ourPatchPath, outPath, options = {}) {
  const baseURL = options.baseURL || "http://127.0.0.1:8081/v1";
  const ours = readPatch(ourPatchPath) || [];
  const user = readPatch(userPatchPath);

  const providerRow = {
    id: "llm-pi-ai",
    name: LLM_PLUGIN_NAME,
    config: { providers: meshMoeProvider(baseURL) },
  };

  let merged;
  if (!user || user.length === 0) {
    merged = [providerRow, ...ours];
  } else {
    merged = user.map((row) => ({ ...row }));
    const userLlm = merged.find((r) => r.name === LLM_PLUGIN_NAME);

    if (userLlm) {
      // Keep the user's providers; ours wins only on the same key.
      userLlm.config = { ...(userLlm.config || {}) };
      userLlm.config.providers = {
        ...(userLlm.config.providers || {}),
        ...meshMoeProvider(baseURL),
      };
    } else {
      merged.push({ ...providerRow });
    }

    // Never touch the default model: the user's choice always wins.

    // Add rows that exist only in our patch (e.g. the runtime plugin row).
    for (const row of ours) {
      const exists = merged.some(
        (r) => (row.id && r.id === row.id) || (row.name && r.name === row.name),
      );
      if (!exists) merged.push({ ...row });
    }
  }

  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, YAML.stringify(merged), "utf8");
    return outPath;
  } catch {
    return null;
  }
}
