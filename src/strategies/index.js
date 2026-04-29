// Strategy registry — auto-loads every *.js file in this folder.
// To add a new strategy: drop a file here exporting { name, config }.
// To remove one: delete the file. The bot picks it up on next restart.
//
// Each strategy file should export `default { name, config }`.
// `config.defaults.enabled` controls whether it fires on startup
// (still toggleable per-strategy from the dashboard).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SELF = path.basename(__filename);

const _strategies = {};
const _names = [];

const files = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.js') && f !== SELF && !f.startsWith('_'))
  .sort();

for (const f of files) {
  try {
    const url = pathToFileURL(path.join(__dirname, f)).href;
    const mod = await import(url);
    const def = mod.default;
    if (!def?.name || !def?.config) {
      console.error(`[strategies] ${f} skipped — missing { name, config } default export`);
      continue;
    }
    if (_strategies[def.name]) {
      console.error(`[strategies] duplicate name "${def.name}" in ${f} — keeping first`);
      continue;
    }
    _strategies[def.name] = def.config;
    _names.push(def.name);
  } catch (err) {
    console.error(`[strategies] failed to load ${f}:`, err.message);
  }
}

console.log(`[strategies] loaded ${_names.length}: ${_names.join(', ')}`);

export const strategyConfigs = _strategies;
export const strategyNames = _names;
