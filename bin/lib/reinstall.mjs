/**
 * What `init` finds when it is run on a project that already has the workflow.
 *
 * The bare command used to ask one question there — "Reconfigure it?" — with
 * the wizard behind yes and the exit behind no. Express existed, but only under
 * `update`, and nothing on the `init` path ever mentioned it. This module is the
 * decision that path was missing: given the manifest and the config file, which
 * of the ways forward is the right one to *recommend*, and which are open at all.
 *
 * Pure, and fed text rather than a path, for the reason `config-keys.mjs` and
 * `wizard-config.mjs` are: a script built out of clack prompts cannot be run
 * without a TTY, so nothing could assert what it decided. The decision is made
 * here and `bin/install.mjs` only renders it.
 *
 * The kinds:
 *
 *   fresh       no config. Files may be installed — a project set up by
 *               /dev-init has a payload and no answers — but the wizard is what
 *               `init` is for, and there is nothing to keep.
 *   express     a config with every setting this version knows about. The
 *               recommendation is to refresh the files and leave it byte for byte.
 *   needs-keys  a config that predates a setting. Keeping it and appending the
 *               missing keys is the recommendation; the keys are listed so the
 *               prompt can say how many.
 *   corrupt     a file that is not a JSON object. Nothing in it can be kept or
 *               diffed, so express is not offered and the wizard starts over.
 */
import { missingConfigKeys } from './config-keys.mjs';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {{manifest: object|null, configText: string|null}} input
 *   `manifest` as `readManifest` returns it, or null when the files were never
 *   installed; `configText` the raw `.dev-workflow.json`, or null when absent.
 * @returns {{
 *   kind: 'fresh'|'express'|'needs-keys'|'corrupt',
 *   recommended: 'express'|'keep'|'replace'|null,
 *   config: object|null,
 *   missing: object[],
 *   installed: string|null,
 * }}
 *   `missing` holds registry entries, in registry order, so a derived default
 *   sees the answer it derives from. `installed` is the version the manifest
 *   records, whatever the kind — the wizard's last step names it.
 */
export function classifyProject({ manifest, configText }) {
  const installed = manifest?.installation?.version ?? null;
  const result = (kind, recommended, config = null, missing = []) => ({ kind, recommended, config, missing, installed });

  if (configText === null || configText === undefined) return result('fresh', null);

  let config;
  try {
    config = JSON.parse(configText);
  } catch {
    return result('corrupt', 'replace');
  }
  if (!isPlainObject(config)) return result('corrupt', 'replace');

  const missing = missingConfigKeys(config);
  return missing.length ? result('needs-keys', 'keep', config, missing) : result('express', 'express', config);
}
