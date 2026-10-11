#!/usr/bin/env node
// Fills the {{KEY}} placeholders in wrangler.toml (the template) from a deploy config and
// writes the real wrangler config. Plain Node, no dependencies; never prints values.
//
//   node scripts/configure.mjs [--config <deploy config .json>] [--out <file>]
//
// Deploy config, first match: --config <file>; the DEPLOY_CONFIG environment variable (the
// JSON itself, e.g. a Workers Builds build variable); deploy.config.json.
// Output: --out, default wrangler.generated.toml. It must sit in the repo root, because the
// template's paths (main, assets) are relative to the config file.
// Keys and example values: deploy.config.example.json. Keys in OPTIONS and LEGACY_KEYS may be left out.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = resolve(ROOT, "wrangler.toml");
const TOKEN = /\{\{([A-Z0-9_]+)\}\}/g;
// Characters that would break out of (or corrupt) a TOML basic string.
const UNSAFE = /["\\\u0000-\u001f\u007f]/;

/** Optional placeholder keys and their defaults (none at the moment: every placeholder is required). */
export const DEFAULTS = {};

/**
 * Pre-dashboard keys, now dashboard settings and ids the Worker keeps in D1. Each one a deploy config
 * still has (even empty) is written to [vars] (`# {{LEGACY_VARS}}`), and to [env.test.vars]
 * (`# {{LEGACY_TEST_VARS}}`) except AI_EDITOR, so an existing instance can deploy this version with
 * its old config: the Worker copies them into D1 once (importLegacyConfig in src/runtime.ts). Then
 * remove them from the deploy config; nothing changes. Keys a config leaves out aren't rendered;
 * the Worker reads an absent playlist id as "" (off), which is what the old template defaulted to.
 */
export const LEGACY_KEYS = [
  "SPOTIFY_USER_ID",
  "SPOTIFY_ALL_PLAYLIST_ID",
  "SPOTIFY_FREQUENT_PLAYLIST_ID",
  "SPOTIFY_HINDI_FAVORITES_PLAYLIST_ID",
  "TIME_ZONE",
  "FREQUENT_MIN_PLAYS",
  "AI_EDITOR",
];
const LEGACY_LINE = /^# \{\{(LEGACY_VARS|LEGACY_TEST_VARS)\}\}\n/gm;

/**
 * Optional structured (lowercase) keys, not placeholders:
 * - imports: false leaves out the template's {{#imports}} blocks (the R2 bucket and the Workflow
 *   named <WORKER_NAME>-imports / <WORKER_NAME>-import, and their test copies).
 * - settings: dashboard setting defaults for this deployment (src/settings.ts), written to the
 *   SETTINGS var as JSON. Values are true/false, numbers or text.
 */
export const OPTIONS = { imports: true, settings: {} };

// "# {{#name}}" ... "# {{/name}}" on lines of their own: kept (without the marker lines) or dropped.
const SECTION = /^# \{\{#([a-z]+)\}\}\n([\s\S]*?)^# \{\{\/\1\}\}\n/gm;
// R2 bucket names; Workflow names allow these too.
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** Problems with the OPTIONS keys, naming keys only (never values). */
function optionProblems(config) {
  const problems = [];
  if ("SETTINGS" in config) problems.push('use "settings" (an object), not SETTINGS');
  if ("imports" in config && typeof config.imports !== "boolean") problems.push("imports must be true or false");
  if ("settings" in config) {
    const s = config.settings;
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      problems.push("settings must be an object of setting key -> value");
    } else {
      const bad = Object.keys(s).filter((k) => !["boolean", "number", "string"].includes(typeof s[k]));
      if (bad.length) problems.push(`settings values must be true/false, numbers or text: ${bad.join(", ")}`);
      // SETTINGS is a TOML literal string ('...'): no apostrophes. JSON escapes control characters.
      if (JSON.stringify(s).includes("'")) problems.push("settings can't contain apostrophes");
    }
  }
  return problems;
}

/**
 * Substitutes every {{KEY}} in `template` with `config[KEY]` (or its default) after resolving the
 * {{#section}} blocks. SETTINGS is derived from `settings`. Throws, naming only the keys, when one
 * is missing, empty (unless it has a default) or unsafe for TOML, or an option is invalid.
 * Returns the text and the config keys the template doesn't use.
 */
export function render(template, config, source = "the deploy config") {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${source} must be a JSON object`);
  const options = { ...OPTIONS, ...config };
  const enabled = { imports: options.imports !== false };
  const legacy = LEGACY_KEYS.filter((k) => k in config);
  const legacyLines = (keys) => keys.filter((k) => typeof config[k] === "string" && !UNSAFE.test(config[k])).map((k) => `${k} = "${config[k]}"\n`).join("");
  const body = template
    .replace(SECTION, (_, name, inner) => {
      if (!(name in enabled)) throw new Error(`wrangler.toml: unknown section {{#${name}}}`);
      return enabled[name] ? inner : "";
    })
    .replace(LEGACY_LINE, (_, name) => legacyLines(name === "LEGACY_VARS" ? legacy : legacy.filter((k) => k !== "AI_EDITOR")));
  if (/\{\{[#/]/.test(body)) throw new Error("wrangler.toml: a {{#section}} marker has no match (markers are whole lines: # {{#name}} ... # {{/name}})");
  const keys = [...new Set(Array.from(body.matchAll(TOKEN), (m) => m[1]))];
  const derived = { SETTINGS: JSON.stringify(typeof options.settings === "object" && options.settings ? options.settings : {}) };
  const values = { ...DEFAULTS, ...config, ...derived };
  const given = keys.filter((k) => !(k in derived));
  const missing = given.filter((k) => typeof values[k] !== "string" || (values[k] === "" && !(k in DEFAULTS)));
  const unsafe = given.filter((k) => typeof values[k] === "string" && UNSAFE.test(values[k]));
  const problems = optionProblems(config);
  const badLegacy = legacy.filter((k) => typeof config[k] !== "string" || UNSAFE.test(config[k]));
  if (badLegacy.length) problems.push(`legacy keys must be text without quotes, backslashes or control characters: ${badLegacy.join(", ")}`);
  if (missing.length) problems.push(`missing or empty (strings required): ${missing.join(", ")}`);
  if (unsafe.length) problems.push(`quotes, backslashes or control characters in: ${unsafe.join(", ")}`);
  if (enabled.imports) {
    const names = ["WORKER_NAME", "TEST_WORKER_NAME"].filter((k) => typeof values[k] === "string" && values[k] && !BUCKET_NAME.test(`${values[k]}-imports`));
    if (names.length) problems.push(`with imports on, <name>-imports must be a valid R2 bucket name (3-63 lowercase letters, digits, dashes): ${names.join(", ")}`);
  }
  if (problems.length) throw new Error(`${source}: ${problems.join("; ")}. See deploy.config.example.json.`);
  return {
    text: body.replace(TOKEN, (_, k) => values[k]),
    unused: Object.keys(config).filter((k) => !keys.includes(k) && !(k in OPTIONS) && !LEGACY_KEYS.includes(k)),
    legacy,
  };
}

/** Renders the template with `config` into `out` (relative to the repo root). */
export function generate(config, out = "wrangler.generated.toml", source) {
  const target = resolve(ROOT, out);
  if (dirname(target) !== ROOT) throw new Error(`--out must be a file in the repo root (got ${out})`);
  const { text, unused, legacy } = render(readFileSync(TEMPLATE, "utf8"), config, source);
  const header = "# GENERATED by scripts/configure.mjs from wrangler.toml. Don't edit: change the template or your deploy config.\n";
  writeFileSync(target, header + text);
  return { file: relative(ROOT, target), unused, legacy };
}

function parseJson(text, source) {
  try {
    return JSON.parse(text);
  } catch {
    // JSON.parse's message can quote the input; keep values out of build logs.
    throw new Error(`${source} is not valid JSON`);
  }
}

function loadConfig(argv) {
  const at = argv.indexOf("--config");
  if (at >= 0) {
    const file = argv[at + 1];
    if (!file) throw new Error("--config needs a file");
    return { source: file, config: parseJson(readFileSync(resolve(file), "utf8"), file) };
  }
  if (process.env.DEPLOY_CONFIG) return { source: "DEPLOY_CONFIG", config: parseJson(process.env.DEPLOY_CONFIG, "DEPLOY_CONFIG") };
  const local = resolve(ROOT, "deploy.config.json");
  if (existsSync(local)) return { source: "deploy.config.json", config: parseJson(readFileSync(local, "utf8"), "deploy.config.json") };
  throw new Error("No deploy config: copy deploy.config.example.json to deploy.config.json and fill it in, or set DEPLOY_CONFIG");
}

function main(argv) {
  const { source, config } = loadConfig(argv);
  const at = argv.indexOf("--out");
  const { file, unused, legacy } = generate(config, at >= 0 ? argv[at + 1] : undefined, source);
  console.log(`Wrote ${file} from ${source}.`);
  if (unused.length) console.warn(`Ignored keys the template doesn't use: ${unused.join(", ")}`);
  if (legacy.length) {
    console.warn(`Pre-dashboard keys written as vars: ${legacy.join(", ")}. The Worker copies them into D1 on its first run; then remove them from ${source} (README, "Upgrading").`);
  }
}

// Run as a script (not imported, as vitest.config.ts does). realpath: /tmp vs /private/tmp etc.
const isMain = () => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isMain()) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`configure: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
