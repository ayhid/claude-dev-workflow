#!/usr/bin/env node
/**
 * What a session actually cost, and whether a change to the workflow made it cheaper.
 *
 *   node tools/profile.mjs                 across every session for this project
 *   node tools/profile.mjs --by ticket     per ticket, joined with the transition log
 *   node tools/profile.mjs --by session
 *   node tools/profile.mjs --by tool
 *   node tools/profile.mjs --since 7d
 *   node tools/profile.mjs --json          a snapshot to diff against a later one
 *
 * **Repo-local development tooling. Not shipped.** It reads Claude Code's own
 * transcripts under `~/.claude/projects/`, which are not project files and are
 * none of the payload's business — `package.json#files` does not list `tools/`,
 * so this never reaches a user's machine.
 *
 * ## Why it measures what it measures
 *
 * Token *counts* come from the API's own `usage` block and are exact. What they
 * are worth is not: a cached read costs about a tenth of a fresh input token
 * and an output token about five times one, so counting raw tokens ranks the
 * cheapest thing first. Everything here is therefore reported **cost-weighted**,
 * in units of one input token, and the ratios are stated where they are applied.
 *
 * The finding that shaped this tool: in a long session, cache reads and cache
 * writes are ~90% of spend and output is ~10%. Cost is context multiplied by
 * turns, which means **the lever is turn count**, not prose length. So `--by
 * tool` exists to show which tools a session spends its turns on: a step that
 * takes eight calls and could take one is worth more than any amount of
 * shortening a SKILL.md.
 *
 * ## The join
 *
 * A transcript records the git branch it was on; `issueIdFromBranch` turns that
 * into a ticket; `.dev-workflow.metrics.jsonl` already holds that ticket's
 * elapsed time, restarts and whether its criteria passed first time. Together
 * they answer the question neither can alone: what did this ticket cost, in
 * tokens and in turns, for the time it took.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { issueIdFromBranch } from '../lib/branch.mjs';
import { loadConfig } from '../lib/config.mjs';
import { metricsFileOf, parseLog } from '../lib/metrics.mjs';

/**
 * What one token of each kind costs, relative to one uncached input token.
 *
 * Stated here rather than folded into a single number so a reader can check
 * them against the pricing page. Output is 5x input across the current model
 * line-up; cache read and cache write are the standard ratios.
 */
export const WEIGHTS = {
  input_tokens: 1,
  cache_creation_input_tokens: 1.25,
  cache_read_input_tokens: 0.1,
  output_tokens: 5,
};

/** USD per million input tokens. Output is priced by the multiplier above. */
export const INPUT_USD_PER_M = {
  'claude-fable-5': 10,
  'claude-mythos-5': 10,
  'claude-opus-5': 5,
  'claude-opus-4-8': 5,
  'claude-opus-4-7': 5,
  'claude-opus-4-6': 5,
  'claude-sonnet-5': 2,
  'claude-sonnet-4-6': 3,
  'claude-haiku-4-5': 1,
};

/** Cost-weighted tokens, in units of one input token. */
export function weigh(usage = {}) {
  let total = 0;
  for (const [field, weight] of Object.entries(WEIGHTS)) total += (usage[field] ?? 0) * weight;
  return total;
}

/**
 * Dollars for one usage block.
 *
 * An unknown model is priced at null rather than guessed: a made-up rate in a
 * report about cost is worse than a blank, because nothing downstream would
 * ever question it.
 */
export function costOf(usage, model) {
  const weighted = weigh(usage);

  // Nothing costs nothing, whatever model did not run. Without this, a session
  // that opened and did nothing — no assistant turn, so no model recorded —
  // priced as null, and one null marks its whole ticket unpriced in `byTicket`.
  // A stub transcript would blank the cost of every real session beside it.
  if (weighted === 0) return 0;

  const rate = INPUT_USD_PER_M[priceKey(model)];
  if (!rate) return null;
  return (weighted * rate) / 1_000_000;
}

/**
 * The price-table key for a model id.
 *
 * Claude Code records whatever id the request used, and some are dated
 * snapshots: `claude-sonnet-4-5-20250929` is the same model, at the same price,
 * as `claude-sonnet-4-5`. An exact-match lookup reports those as unpriced,
 * which is a blank in a cost report for no reason at all.
 */
export function priceKey(model) {
  return String(model ?? '').replace(/-\d{8}$/, '');
}

const emptyTotals = () => ({
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
});

/**
 * Fold a transcript's records into one session summary.
 *
 * Sidechain turns (subagents) are counted: they are real spend, and a change
 * that moves work into a subagent has not saved anything if they are excluded.
 *
 * @param {object[]} records  parsed JSONL lines, in file order
 */
export function foldSession(records) {
  const totals = emptyTotals();
  const tools = new Map();
  let turns = 0;
  let sidechainTurns = 0;
  let model = null;
  let branch = null;
  let first = null;
  let last = null;
  const unknownModels = new Set();

  for (const r of records) {
    if (r.gitBranch && r.gitBranch !== 'HEAD') branch = r.gitBranch;
    if (r.timestamp) {
      if (!first || r.timestamp < first) first = r.timestamp;
      if (!last || r.timestamp > last) last = r.timestamp;
    }

    const msg = r.message ?? {};
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === 'tool_use') tools.set(block.name, (tools.get(block.name) ?? 0) + 1);
      }
    }

    if (r.type !== 'assistant') continue;
    const usage = msg.usage;
    if (!usage) continue;

    turns++;
    if (r.isSidechain) sidechainTurns++;
    if (msg.model) {
      model ??= msg.model;
      if (!INPUT_USD_PER_M[priceKey(msg.model)]) unknownModels.add(msg.model);
    }
    for (const field of Object.keys(totals)) totals[field] += usage[field] ?? 0;
  }

  return {
    totals,
    turns,
    sidechainTurns,
    model,
    branch,
    first,
    last,
    unknownModels: [...unknownModels].sort(),
    tools: [...tools.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    weighted: weigh(totals),
    usd: costOf(totals, model),
  };
}

/** `7d`, `48h`, `2w` → an ISO cutoff. Same vocabulary as `dev.mjs sync --since`. */
export function cutoffFor(since, now = new Date()) {
  if (!since) return null;
  const m = /^(\d+)([dhw]?)$/.exec(String(since).trim());
  if (!m) throw new Error('--since takes a value like 7d, 48h or 2w');
  const perUnit = { d: 1440, h: 60, w: 10080, '': 1440 };
  return new Date(now.getTime() - Number(m[1]) * perUnit[m[2]] * 60_000).toISOString();
}

/**
 * Group sessions by the ticket their branch names, and attach what the
 * transition log already knows about that ticket.
 *
 * A session on a branch carrying no issue ID is kept under `(no ticket)` rather
 * than dropped — ticketless work is real work and hiding its cost would flatter
 * every average here.
 */
export function byTicket(sessions, { config, metrics = [] } = {}) {
  const groups = new Map();

  for (const s of sessions) {
    const id = (s.branch && issueIdFromBranch(config, s.branch)) || '(no ticket)';
    if (!groups.has(id)) {
      groups.set(id, { id, sessions: 0, turns: 0, weighted: 0, usd: 0, usdKnown: true, totals: emptyTotals() });
    }
    const g = groups.get(id);
    g.sessions++;
    g.turns += s.turns;
    g.weighted += s.weighted;
    if (s.usd === null) g.usdKnown = false;
    else g.usd += s.usd;
    for (const field of Object.keys(g.totals)) g.totals[field] += s.totals[field];
  }

  // What the ticket cost in tokens is only half the question; the other half is
  // already recorded by the workflow itself.
  for (const [id, g] of groups) {
    const closes = metrics.filter((e) => e.id === id && (e.event === 'done' || e.event === 'abandon'));
    const close = closes[closes.length - 1];
    g.outcome = close?.event ?? null;
    g.elapsedMs = close?.elapsedMs ?? null;
    g.starts = close?.starts ?? null;
    g.criteria = close?.criteria ?? null;
  }

  return [...groups.values()].sort((a, b) => b.weighted - a.weighted);
}

// --- IO -------------------------------------------------------------------------

/** Claude Code's transcript directory for a working directory. */
export function transcriptDirFor(cwd, home = homedir()) {
  return join(home, '.claude', 'projects', resolve(cwd).replace(/[/.]/g, '-'));
}

function readTranscripts(dir, cutoff) {
  if (!existsSync(dir)) return [];
  const out = [];

  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);

    const records = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // A transcript being written while this reads it ends in a partial
        // line. Skipping it costs one turn of one session, and refusing to
        // report at all over it would be worse.
      }
    }
    if (!records.length) continue;

    const session = foldSession(records);
    if (cutoff && (session.last ?? '') < cutoff) continue;
    out.push({ ...session, id: name.replace(/\.jsonl$/, ''), path, bytes: statSync(path).size });
  }

  return out.sort((a, b) => (a.first ?? '').localeCompare(b.first ?? ''));
}

// --- rendering ------------------------------------------------------------------

const n = (v) => (v ?? 0).toLocaleString('en-US');
const usd = (v) => (v === null || v === undefined ? '     -' : `$${v.toFixed(2)}`);
const dur = (ms) => (ms === null || ms === undefined ? '-' : `${Math.round(ms / 3_600_000)}h`);

function renderSummary(sessions) {
  const totals = emptyTotals();
  let turns = 0;
  let dollars = 0;
  let known = true;
  for (const s of sessions) {
    turns += s.turns;
    for (const f of Object.keys(totals)) totals[f] += s.totals[f];
    if (s.usd === null) known = false;
    else dollars += s.usd;
  }

  const weighted = weigh(totals);
  const L = [`sessions: ${sessions.length}   assistant turns: ${n(turns)}`, ''];
  L.push(`${'component'.padEnd(36)} ${'raw'.padStart(15)} ${'weighted'.padStart(15)}  share`);
  L.push('-'.repeat(76));
  for (const [field, weight] of Object.entries(WEIGHTS)) {
    const w = totals[field] * weight;
    L.push(
      `${`${field} (${weight}x)`.padEnd(36)} ${n(totals[field]).padStart(15)} ` +
        `${n(Math.round(w)).padStart(15)}  ${weighted ? ((100 * w) / weighted).toFixed(1) : '0.0'}%`,
    );
  }
  L.push('-'.repeat(76));
  L.push(`${'TOTAL'.padEnd(36)} ${''.padStart(15)} ${n(Math.round(weighted)).padStart(15)}  ${known ? usd(dollars) : '(unpriced model)'}`);
  L.push('', `cost per turn: ${turns ? usd(known ? dollars / turns : null) : '-'}   ← the number a deterministic step reduces`);
  return L;
}

function renderTickets(rows) {
  const L = [
    `${'TICKET'.padEnd(12)} ${'SESSIONS'.padStart(8)} ${'TURNS'.padStart(6)} ${'WEIGHTED'.padStart(13)} ${'COST'.padStart(8)} ${'ELAPSED'.padStart(8)} ${'STARTS'.padStart(6)}  CRITERIA`,
    '-'.repeat(88),
  ];
  for (const r of rows) {
    L.push(
      `${r.id.padEnd(12)} ${String(r.sessions).padStart(8)} ${String(r.turns).padStart(6)} ` +
        `${n(Math.round(r.weighted)).padStart(13)} ${(r.usdKnown ? usd(r.usd) : '-').padStart(8)} ` +
        `${dur(r.elapsedMs).padStart(8)} ${String(r.starts ?? '-').padStart(6)}  ${r.criteria ?? '-'}`,
    );
  }
  if (!rows.length) L.push('(no sessions in the window)');
  return L;
}

function renderSessions(sessions) {
  const L = [
    `${'SESSION'.padEnd(10)} ${'STARTED'.padEnd(11)} ${'TURNS'.padStart(6)} ${'WEIGHTED'.padStart(13)} ${'COST'.padStart(8)}  BRANCH`,
    '-'.repeat(80),
  ];
  for (const s of sessions) {
    L.push(
      `${s.id.slice(0, 8).padEnd(10)} ${(s.first ?? '').slice(0, 10).padEnd(11)} ${String(s.turns).padStart(6)} ` +
        `${n(Math.round(s.weighted)).padStart(13)} ${usd(s.usd).padStart(8)}  ${s.branch ?? '-'}`,
    );
  }
  if (!sessions.length) L.push('(no sessions in the window)');
  return L;
}

function renderTools(sessions) {
  const tally = new Map();
  for (const s of sessions) for (const [name, count] of s.tools) tally.set(name, (tally.get(name) ?? 0) + count);

  const rows = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const calls = rows.reduce((sum, [, c]) => sum + c, 0);
  const turns = sessions.reduce((sum, s) => sum + s.turns, 0);

  const L = [
    `${calls} tool calls across ${turns} turns`,
    '',
    `${'TOOL'.padEnd(34)} ${'CALLS'.padStart(6)}  share`,
    '-'.repeat(52),
  ];
  for (const [name, count] of rows) {
    L.push(`${name.padEnd(34)} ${String(count).padStart(6)}  ${calls ? ((100 * count) / calls).toFixed(1) : '0.0'}%`);
  }
  L.push('', 'A step taking many calls that could take one is the cheapest thing to fix:');
  L.push('every turn re-reads the whole context, so removing a turn saves a whole context read.');
  return L;
}

// --- entry point ------------------------------------------------------------------

const USAGE = `usage: node tools/profile.mjs [--by summary|ticket|session|tool] [--since 7d] [--json] [--dir PATH]`;

export async function main(argv = process.argv.slice(2)) {
  const opts = { by: 'summary', since: null, json: false, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--by') opts.by = argv[++i];
    else if (a === '--since') opts.since = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--dir') opts.dir = argv[++i];
    else if (a === '-h' || a === '--help') return print(USAGE);
    else return fail(`unknown argument '${a}'\n\n${USAGE}`);
  }

  const { config, root } = loadConfig();
  const dir = opts.dir ?? transcriptDirFor(root);
  if (!existsSync(dir)) {
    return fail(
      `no transcripts at ${dir}\n` +
        'Claude Code writes them per working directory; pass --dir if this project is driven from another path.',
    );
  }

  let cutoff = null;
  try {
    cutoff = cutoffFor(opts.since);
  } catch (err) {
    return fail(err.message);
  }

  const sessions = readTranscripts(dir, cutoff);
  const metricsPath = resolve(root, metricsFileOf(config));
  const metrics = existsSync(metricsPath) ? parseLog(readFileSync(metricsPath, 'utf8')).events : [];
  const tickets = byTicket(sessions, { config, metrics });

  if (opts.json) {
    return print(JSON.stringify({ dir, since: opts.since ?? null, sessions, tickets }, null, 2));
  }

  const views = {
    summary: () => renderSummary(sessions),
    ticket: () => renderTickets(tickets),
    session: () => renderSessions(sessions),
    tool: () => renderTools(sessions),
  };
  const view = views[opts.by];
  if (!view) return fail(`unknown --by "${opts.by}" — expected ${Object.keys(views).join(', ')}`);

  const unpriced = [...new Set(sessions.flatMap((s) => s.unknownModels))].sort();
  if (unpriced.length) {
    process.stderr.write(
      `note: no price known for ${unpriced.join(', ')} — those rows read "-" rather than a guess.\n` +
        'Add it to INPUT_USD_PER_M in tools/profile.mjs to price them.\n',
    );
  }
  return print(view().join('\n'));
}

const print = (text) => {
  process.stdout.write(`${text}\n`);
  return 0;
};
const fail = (message) => {
  process.stderr.write(`profile: ${message}\n`);
  return 1;
};

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
