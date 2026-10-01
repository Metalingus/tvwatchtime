@AGENTS.md

## Claude Code specifics
- **Path-scoped rules** in `.claude/rules/` load automatically when you read matching files:
  `mobile`, `api`, `admin`, `auth`, `database`, `import`, `commsuni`, `metadata`, `social`,
  `notifications`, `integrations`. They hold area conventions and key files. Don't duplicate
  their content here.
- **Guard hook** (`.claude/hooks/guard-commands.mjs`) runs before Bash/PowerShell calls. It denies
  unsafe `tsc` usage and `rtk pnpm`/`rtk tsc`. It asks for approval on builds, exports, pushes,
  deploys, Prisma writes, and `.env` access. If it blocks a command, follow its message; don't
  rephrase the command to get around it.
- **Search:** use the Grep/Glob tools scoped to `apps/<app>/src`, `apps/mobile/{app,components,api}`,
  or `packages/shared/src`. Never search `node_modules`, `dist`, `build`, `.expo`, `.pnpm-store`,
  `apps/app-web`, or `coverage`.
- **Shell:** `rtk` is installed and optional for compacting noisy output (`rtk git diff`,
  `rtk jest`, `rtk grep`). The `rtk pnpm` / `rtk tsc` ban in AGENTS.md applies.
- **Delegation:** use the Explore agent for broad "where is X handled" sweeps across apps. It
  keeps large file dumps out of the main context.
- **Personal notes** go in `CLAUDE.local.md` (gitignored), not in this file.
