#!/usr/bin/env node
// PreToolUse guard for Bash/PowerShell commands. Enforces the AGENTS.md rules that prose alone
// has failed to guarantee:
//   deny: tsc with source-file args or without --noEmit (emits .js next to sources), rtk pnpm/tsc
//   ask:  approval gates (builds/exports, pushes/publishes/deploys, Prisma writes, destructive
//         docker ops, root full test suite, .env access)
// Anything else falls through to the normal permission flow.
import { readFileSync } from 'node:fs';

const INFO_FLAGS = new Set(['--version', '-v', '--help', '-h', '--showConfig', '--init', '--all']);

function splitSegments(command) {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tokenize(segment) {
  return segment
    .split(/\s+/)
    .map((t) => t.replace(/^['"`]+|['"`]+$/g, ''))
    .filter(Boolean);
}

function checkTsc(tokens) {
  const idx = tokens.findIndex((t) => /(^|[\\/])tsc(\.cmd|\.exe)?$/i.test(t));
  if (idx === -1) return null;
  const args = tokens.slice(idx + 1);
  if (args.some((a) => INFO_FLAGS.has(a))) return null;
  for (let i = 0; i < args.length; i++) {
    const prev = args[i - 1];
    if (/\.[cm]?tsx?$/i.test(args[i]) && prev !== '-p' && prev !== '--project') {
      return 'tsc was given source files, which bypasses the workspace tsconfig and emits .js beside sources. Use `pnpm --filter <workspace> typecheck` or `tsc -p <tsconfig.json> --noEmit`.';
    }
  }
  if (!args.some((a) => /^--noEmit(=true)?$/.test(a))) {
    return 'tsc without --noEmit can emit .js/.d.ts files beside sources. Use `pnpm --filter <workspace> typecheck` or `tsc -p <tsconfig.json> --noEmit`.';
  }
  return null;
}

const ASK_RULES = [
  [/\bdocker\s+(push|build|buildx)\b/i, 'gate #1 / owner-run builds: docker build/push'],
  [/\bdocker\s+(volume\s+(rm|prune)|system\s+prune)\b/i, 'gate #3: destroys local docker data'],
  [/\bdocker[\s-]compose\b.*\bdown\b.*(\s-v\b|--volumes)/i, 'gate #3: deletes local DB volumes'],
  [/\b(git\s+push|(npm|pnpm|yarn)\s+publish)\b/i, 'gate #1: publishes outside this machine'],
  [/\b(ssh|scp)\s/i, 'gate #1/#2: remote server access'],
  [/\bdeploy\.ps1\b/i, 'gate #1: deployment script'],
  [/\beas\s+(build|submit|update)\b/i, 'gate #1 / owner-run builds: EAS'],
  [/\bexpo\s+(export|prebuild|run:(android|ios))\b/i, 'owner-run builds/exports: Expo'],
  [/\b(next|nest)\s+build\b/i, 'owner-run builds'],
  [/\bpnpm(\s+(-r|--recursive|run|(--filter|-F)\s+\S+))*\s+build\b/i, 'owner-run builds'],
  [/--accept-data-loss|--force-reset/i, 'gate #3: destructive Prisma flag. Confirm the DB is disposable or backed up'],
  [/\bprisma\s+(migrate\s+(deploy|reset|dev|resolve)|db\s+(push|execute|seed|pull))\b/i, 'gate #2: Prisma DB/schema write. Confirm the target database first'],
  [/\bdb:(migrate|push|seed|backfill[\w-]*)\b/i, 'gate #2: database write script. Confirm the target database first'],
  [/^\s*pnpm\s+(-r\s+)?(run\s+)?test\s*$/i, 'gate #4: full repository test suite. Prefer a focused test'],
];

function isEnvFileToken(token) {
  const m = /(^|[\\/=])\.env(\.[\w.-]+)?$/i.exec(token);
  return Boolean(m) && !/\.(example|sample|template)$/i.test(token);
}

function evaluate(command) {
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);
    if (/^rtk$/i.test(tokens[0] ?? '') && /^(pnpm|tsc)$/i.test(tokens[1] ?? '')) {
      return { decision: 'deny', reason: '`rtk pnpm` / `rtk tsc` invoke tsc without --noEmit and emit .js files. Run the command without rtk.' };
    }
    const tscProblem = checkTsc(tokens);
    if (tscProblem) return { decision: 'deny', reason: tscProblem };
  }
  for (const segment of splitSegments(command)) {
    for (const [re, why] of ASK_RULES) {
      if (re.test(segment)) return { decision: 'ask', reason: `AGENTS.md approval required (${why}).` };
    }
    if (tokenize(segment).some(isEnvFileToken)) {
      return { decision: 'ask', reason: 'Command references a real .env file that holds secrets. Never print its values.' };
    }
  }
  return null;
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
const command = input?.tool_input?.command;
if (typeof command !== 'string') process.exit(0);

const result = evaluate(command);
if (result) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: result.decision,
        permissionDecisionReason: result.reason,
      },
    }),
  );
}
process.exit(0);
