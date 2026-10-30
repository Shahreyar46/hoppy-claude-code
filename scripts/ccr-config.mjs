// Reads and edits claude-code-router (ccr v3) config, which lives in SQLite.
// Run with system Node 22.5+ (needs node:sqlite). ccr must be stopped before "apply".
//
//   node ccr-config.mjs status
//   node ccr-config.mjs apply              (JSON options on stdin, see applyConfig)
//   node ccr-config.mjs restore-takeover   (undo ccr's takeover of ~/.claude and ~/.codex)
//
// Output is always one JSON object on stdout. API keys are never printed.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const CCR_DIR = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'claude-code-router');
const DB_PATH = join(CCR_DIR, 'config.sqlite');
const TAKEOVER_PATH = join(CCR_DIR, 'global-profile-takeover.json');

const PROVIDER_TEMPLATES = {
  openrouter: {
    api_base_url: 'https://openrouter.ai/api/v1/chat/completions',
    transformer: { use: ['openrouter'] },
    models: [],
  },
  gemini: {
    api_base_url: 'https://generativelanguage.googleapis.com/v1beta/models/',
    transformer: { use: ['gemini'] },
    models: ['gemini-3.8-flash'],
  },
  deepseek: {
    api_base_url: 'https://api.deepseek.com/chat/completions',
    transformer: { use: ['deepseek'] },
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  glm: {
    api_base_url: 'https://api.z.ai/api/paas/v4/chat/completions',
    models: ['glm-5.3'],
  },
  // OpenAI-compatible; the extension fills the model list from each provider's live /models.
  groq: {
    api_base_url: 'https://api.groq.com/openai/v1/chat/completions',
    models: [],
  },
  cerebras: {
    api_base_url: 'https://api.cerebras.ai/v1/chat/completions',
    models: [],
  },
  mistral: {
    api_base_url: 'https://api.mistral.ai/v1/chat/completions',
    models: [],
  },
  nvidia: {
    api_base_url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    models: [],
  },
};

// Providers that would bill Claude per token. Never kept in the router.
const FORBIDDEN_PROVIDERS = new Set(['anthropic', 'claude']);

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function openDb() {
  if (!existsSync(DB_PATH)) {
    return null;
  }
  return new DatabaseSync(DB_PATH);
}

function loadConfig(db) {
  const row = db.prepare("SELECT value_json FROM app_config WHERE key = 'default'").get();
  return row ? JSON.parse(row.value_json) : null;
}

function saveConfig(db, cfg) {
  db.prepare("UPDATE app_config SET value_json = ?, updated_at = ? WHERE key = 'default'")
    .run(JSON.stringify(cfg), new Date().toISOString());
}

function isPlaceholder(key) {
  return !key || key.startsWith('$');
}

function status() {
  const db = openDb();
  if (!db) {
    return out({ exists: false });
  }
  const cfg = loadConfig(db);
  db.close();
  if (!cfg) {
    return out({ exists: false });
  }
  const claudeProfile = cfg.profile?.profiles?.find((p) => p.agent === 'claude-code');
  const codexProfile = cfg.profile?.profiles?.find((p) => p.agent === 'codex');
  out({
    exists: true,
    providers: (cfg.Providers || []).map((p) => ({
      name: p.name,
      hasKey: !isPlaceholder(p.api_key),
      keyHint: isPlaceholder(p.api_key) ? null : p.api_key.slice(-4),
      models: p.models || [],
    })),
    fallback: cfg.Router?.fallback ?? null,
    claudeSettingsFile: claudeProfile?.settingsFile ?? null,
    claudeModel: claudeProfile?.model ?? null,
    codexEnabled: codexProfile ? codexProfile.enabled !== false : false,
  });
}

// Options (stdin JSON):
// {
//   keys: { openrouter?: string, gemini?: string, deepseek?: string, glm?: string },
//   freeModels?: string[],          // OpenRouter ids without the "openrouter/" prefix
//   fallback?: string[],            // full selectors, e.g. "openrouter/x/y:free"
//   providerModels?: { [provider]: string[] },  // exact enabled model list per provider
//   removeProviders?: string[],     // turn providers off (the extension keeps their keys in secret storage)
//   mainModel?: string, smallModel?: string,
//   routerSettingsFile: string      // e.g. "~/.claude-router/settings.json"
// }
function applyConfig() {
  const opts = JSON.parse(readStdin() || '{}');
  const db = openDb();
  if (!db) {
    return out({ ok: false, error: 'ccr config not found. Start ccr once first.' });
  }
  const cfg = loadConfig(db);
  const changes = [];

  const remove = new Set(opts.removeProviders || []);
  cfg.Providers = (cfg.Providers || []).filter((p) => {
    if (FORBIDDEN_PROVIDERS.has(p.name)) {
      changes.push(`removed provider ${p.name} (would bill Claude per token)`);
      return false;
    }
    if (remove.has(p.name)) {
      changes.push(`turned off ${p.name}`);
      return false;
    }
    return true;
  });

  for (const [name, key] of Object.entries(opts.keys || {})) {
    if (!key || !PROVIDER_TEMPLATES[name]) {
      continue;
    }
    let provider = cfg.Providers.find((p) => p.name === name);
    if (!provider) {
      provider = {
        id: `provider-${name}-${randomBytes(5).toString('hex')}`,
        name,
        ...structuredClone(PROVIDER_TEMPLATES[name]),
      };
      cfg.Providers.push(provider);
      changes.push(`added provider ${name}`);
    }
    provider.api_key = key.trim();
    changes.push(`set key for ${name}`);
  }

  if (Array.isArray(opts.freeModels) && opts.freeModels.length) {
    const openrouter = cfg.Providers.find((p) => p.name === 'openrouter');
    if (openrouter) {
      // Keep paid models the user added by hand; replace the free list.
      const paid = (openrouter.models || []).filter((m) => !m.endsWith(':free'));
      openrouter.models = [...opts.freeModels, ...paid];
      changes.push(`openrouter models: ${opts.freeModels.length} free + ${paid.length} paid`);
    }
  }

  for (const [name, models] of Object.entries(opts.providerModels || {})) {
    const provider = cfg.Providers.find((p) => p.name === name);
    if (provider && Array.isArray(models)) {
      provider.models = [...new Set(models)];
      changes.push(`${name}: ${provider.models.length} models enabled`);
    }
  }

  const configured = new Set(
    cfg.Providers.filter((p) => !isPlaceholder(p.api_key)).flatMap((p) => (p.models || []).map((m) => `${p.name}/${m}`)),
  );
  if (Array.isArray(opts.fallback)) {
    const models = opts.fallback.filter((m) => configured.has(m));
    cfg.Router = cfg.Router || {};
    cfg.Router.fallback = { mode: models.length ? 'model-chain' : 'off', retryCount: 1, models };
    changes.push(`fallback chain: ${models.length} models`);
  }

  if (cfg.profile && opts.routerSettingsFile) {
    const main = opts.mainModel && configured.has(opts.mainModel) ? opts.mainModel : '';
    const small = opts.smallModel && configured.has(opts.smallModel) ? opts.smallModel : main;
    const claudeTargets = [cfg.profile.claudeCode, ...(cfg.profile.profiles || []).filter((p) => p.agent === 'claude-code')];
    for (const t of claudeTargets.filter(Boolean)) {
      t.settingsFile = opts.routerSettingsFile;
      if (main) {
        Object.assign(t, { model: main, opusModel: main, sonnetModel: main, fableModel: main });
      }
      if (small) {
        Object.assign(t, { haikuModel: small, smallFastModel: small });
      }
    }
    if (cfg.profile.codex) {
      cfg.profile.codex.enabled = false;
    }
    for (const p of cfg.profile.profiles || []) {
      if (p.agent === 'codex') {
        p.enabled = false;
      }
    }
    changes.push(`claude-code profile -> ${opts.routerSettingsFile}; codex takeover disabled`);
    writeTakeover(opts.routerSettingsFile);
  }

  saveConfig(db, cfg);
  db.close();
  out({ ok: true, changes });
}

function writeTakeover(routerSettingsFile) {
  const data = {
    profiles: [
      { agent: 'claude-code', id: 'default-claude-code', name: 'Claude Code', settingsFile: routerSettingsFile },
    ],
    version: 1,
  };
  writeFileSync(TAKEOVER_PATH, JSON.stringify(data, null, 2));
}

// ccr's default profile rewrites ~/.claude/settings.json and ~/.codex/config.toml on first start
// and keeps the originals next to them. Put the originals back if the files are still routed.
function restoreTakeover() {
  const restored = [];
  const targets = [
    { file: join(homedir(), '.claude', 'settings.json'), marker: '127.0.0.1:3456' },
    { file: join(homedir(), '.codex', 'config.toml'), marker: 'CCR managed' },
  ];
  for (const { file, marker } of targets) {
    if (!existsSync(file) || !readFileSync(file, 'utf8').includes(marker)) {
      continue;
    }
    const original = `${file}.ccr-original`;
    const missing = `${file}.ccr-original-missing`;
    copyFileSync(file, `${file}.ccr-routed-bak`);
    if (existsSync(original)) {
      copyFileSync(original, file);
      restored.push(file);
    } else if (existsSync(missing)) {
      unlinkSync(file);
      restored.push(`${file} (removed; did not exist before ccr)`);
    }
  }
  out({ ok: true, restored });
}

// Prints one provider's key so the extension can move it into OS secret storage before
// turning the provider off. Only the extension process reads this output.
function exportKey(name) {
  const db = openDb();
  const cfg = db ? loadConfig(db) : null;
  db?.close();
  const p = cfg?.Providers?.find((x) => x.name === name);
  out({ ok: !!p && !isPlaceholder(p.api_key), key: p && !isPlaceholder(p.api_key) ? p.api_key : null });
}

const command = process.argv[2];
try {
  if (command === 'status') {
    status();
  } else if (command === 'export-key') {
    exportKey(process.argv[3]);
  } else if (command === 'apply') {
    applyConfig();
  } else if (command === 'restore-takeover') {
    restoreTakeover();
  } else {
    out({ ok: false, error: `unknown command: ${command}` });
  }
} catch (err) {
  out({ ok: false, error: String(err?.message || err) });
  process.exitCode = 1;
}
