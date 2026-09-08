/**
 * File a plan's work units as sub-issues of the ticket they came from.
 *
 *   dev.mjs split <PARENT> @units.json [--print]
 *
 * The file is what `/dev-split` writes after the user approved the units: one
 * entry per unit with its summary, its body (carrying its own acceptance
 * criteria), its type, and the units it depends on as indexes into the same
 * file — the IDs do not exist yet when the file is written. `lib/units.mjs`
 * validates it and orders it; this command does the writes.
 *
 * Two properties make it safe to run twice, which a partial failure requires:
 *
 *   - Units are filed in **wave order**, so a unit's `Depends on:` line can
 *     name the IDs of the units before it — they exist by then.
 *   - A unit whose title already exists among the parent's children is
 *     **skipped**, and its existing ID stands in for it. The same title match
 *     `create` already falls back on; here it is what keeps a rerun after "3 of
 *     5 filed" from filing the first three again.
 *
 * `--print` renders the plan and files nothing. A cycle is refused before any
 * create, so a bad file never leaves half a split behind.
 */
import { canonicalId } from '../../lib/issueid.mjs';
import { computeWaves, parseUnitsFile, renderUnitBody } from '../../lib/units.mjs';
import { context, must, readArg, UserError } from './common.mjs';

const USAGE = 'usage: dev.mjs split <PARENT-ID> @units.json [--print]';

function parseArgs(args) {
  const opts = { print: false };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--print' || a === '--dry-run') opts.print = true;
    else if (a.startsWith('-')) throw new UserError(`unknown flag ${a}\n\n${USAGE}`);
    else rest.push(a);
  }
  return { opts, rest };
}

export async function run(args) {
  const { opts, rest } = parseArgs(args);
  const [rawParent, fileArg] = rest;
  if (!rawParent || !fileArg) throw new UserError(USAGE);
  if (!fileArg.startsWith('@')) {
    throw new UserError(`the units go in a file: dev.mjs split ${rawParent} @units.json`);
  }

  const { config, provider } = await context();
  const parent = canonicalId(config, rawParent);

  const parsed = parseUnitsFile(readArg(fileArg, 'units file'), config);
  if (!parsed.ok) throw new UserError(parsed.error);
  const units = parsed.units;

  // Ordered before anything is read or written: a cycle is a bad file, and a
  // bad file must not cost a tracker round trip, let alone a filed issue.
  const order = computeWaves(units.map((u, i) => ({ id: String(i), dependsOn: u.dependsOn.map(String) })));
  if (!order.ok) throw new UserError(order.error);

  const issue = must(await provider.getIssue(parent));
  const existing = must(await provider.children(parent));
  const byTitle = new Map(existing.map((c) => [c.title, c]));

  const L = [];
  L.push(`parent:   ${parent} — ${issue.title}`);

  const idOf = new Map(); // unit index -> issue id (or a placeholder under --print)
  const rows = [];
  let filed = 0;
  let skipped = 0;

  const flush = () => {
    L.push(
      `filed:    ${filed} new${skipped ? `, ${skipped} already filed` : ''}${opts.print ? '   (--print: nothing was filed)' : ''}`,
    );
    for (const [w, wave] of order.waves.entries()) {
      L.push(`wave ${w + 1}`);
      for (const key of wave) {
        const row = rows.find((r) => r.key === key);
        if (row) L.push(row.line);
      }
    }
    process.stdout.write(`${L.join('\n')}\n`);
  };

  for (const wave of order.waves) {
    for (const key of wave) {
      const i = Number(key);
      const u = units[i];
      const deps = u.dependsOn.map((d) => idOf.get(String(d))).filter(Boolean);
      const suffix = deps.length ? `   depends on ${deps.join(', ')}` : '';

      const already = byTitle.get(u.summary);
      if (already) {
        idOf.set(key, already.id);
        skipped += 1;
        rows.push({ key, line: `  ${already.id.padEnd(8)} ${u.summary}${suffix}   (already filed)` });
        continue;
      }

      if (opts.print) {
        const placeholder = `unit ${i + 1}`;
        idOf.set(key, placeholder);
        rows.push({ key, line: `  ${placeholder.padEnd(8)} ${u.summary}${suffix}` });
        continue;
      }

      const r = await provider.createChild({
        parent,
        summary: u.summary,
        description: renderUnitBody({ description: u.description, dependsOn: deps, repo: u.repo ?? null }),
        type: u.type,
        priority: u.priority,
      });
      if (!r.ok) {
        // Say what exists before saying what failed: the next run skips the
        // filed ones by title, and the reader should know that is safe.
        flush();
        throw new UserError(
          `unit ${i + 1} "${u.summary}": ${r.error}\n` +
            `${filed + skipped} unit(s) above are filed; rerun the same command and they are skipped by title.`,
        );
      }
      for (const w of r.warnings ?? []) process.stderr.write(`dev split: ${w}\n`);
      idOf.set(key, r.id);
      filed += 1;
      rows.push({ key, line: `  ${r.id.padEnd(8)} ${u.summary}${suffix}` });
    }
  }

  flush();
  return 0;
}
