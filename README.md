# claude-gladiator-mcp

<!-- > **under construction:** This project is under heavy construction and is not intended for public use / nor has it been published to npm. Information in the README below may be outdated, user discretion is advised. -->

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for continuous learning in [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Observe patterns, reflect on them, evolve into native skills that Claude loads automatically.

[![npm version](https://img.shields.io/npm/v/claude-gladiator-mcp.svg)](https://www.npmjs.com/package/claude-gladiator-mcp) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/) [![Claude](https://img.shields.io/badge/Claude-D97757?logo=claude&logoColor=fff)](#) [![GitHub stars](https://img.shields.io/github/stars/Vvkmnn/claude-gladiator-mcp?style=social)](https://github.com/Vvkmnn/claude-gladiator-mcp)

<!-- TODO: Add demo.gif -->

Inspired by [ECC's continuous-learning-v2](https://github.com/affaan-m/everything-claude-code), [Claudeception](https://github.com/blader/Claudeception), and [claude-reflect-system](https://github.com/haddock-development/claude-reflect-system). Learns from what went wrong, what worked, and what keeps happening — then writes its own skills.

## install

Requirements:

- [Claude Code](https://claude.ai/code)

```bash
npm install -g claude-gladiator-mcp
```

**From shell:**

```bash
claude mcp add claude-gladiator-mcp -- bunx claude-gladiator-mcp
```

**From inside Claude** (restart required):

```
Add this to our global mcp config: bunx claude-gladiator-mcp

Install this mcp: https://github.com/Vvkmnn/claude-gladiator-mcp
```

**From any manually configurable `mcp.json`:** (Cursor, Windsurf, etc.)

```json
{
  "mcpServers": {
    "gladiator": {
      "command": "bunx",
      "args": ["claude-gladiator-mcp"],
      "env": {}
    }
  }
}
```

## plugin

For full automation with hooks, install the plugin from [claude-emporium](https://github.com/Vvkmnn/claude-emporium):

```bash
/plugin marketplace add Vvkmnn/claude-emporium
/plugin install claude-gladiator@claude-emporium
```

## features

[MCP server](https://modelcontextprotocol.io/) for continuous learning. Captures observations from hooks and agent activity, clusters them into patterns, and drafts native [Claude Code skills](https://docs.anthropic.com/en/docs/claude-code/skills) that load automatically in future sessions.

Stores observations in `~/.claude/gladiator/observations.jsonl` and writes skills to `~/.claude/skills/gladiator-*/SKILL.md` (and a crossed swords `⚔`):

### gladiator_observe

Record an observation worth learning from. Called by hooks on Edit/Write/Bash errors, or directly by the agent. Deduplicates by summary hash.

```
⚔ gladiator_observe summary=<summary> context?=<context> tags?=<tags>
  > "Used git log without --follow, missed rename history"
  > "Unquoted variable caused glob expansion on filenames with spaces"
  > "ESM module used require() instead of import, got ReferenceError"
```

```
┌─ ⚔ ─────────────────────────────────────────── Recorded ─┐
│ Used git log without --follow, missed rename history      │
│ ID: obs_1771499001452_90cb                                │
│ Tags: git, history, rename                                │
│ Tool: Bash                                                │
│ Error: Only showed 1 commit instead of full history       │
│ Before: git log -3 -- src/new-name.ts                     │
│ After: git log -3 --follow -- src/new-name.ts             │
│ Backlog: 3 unprocessed of 5 total                         │
└───────────────────────────────────────────────────────────┘
```

```
┌─ ⚔ ──────────────────────────────────────────── Skipped ─┐
│ Duplicate observation (hash: e8b38636)                    │
└───────────────────────────────────────────────────────────┘
```

### gladiator_reflect

Analyze unprocessed observations, cluster by tag overlap, return groups with draft SKILL.md content. Agent reviews drafts and writes final skills via Write tool. Marks observations as processed.

```
⚔ gladiator_reflect limit?=<number>
  > "Analyze what I've learned and create skills"
  > "Reflect on recent observations"
```

```
┌─ ⚔ ────────────────────────────────────────── Reflected ─┐
│ 5 observations → 2 groups                                │
│                                                          │
│ NEW: gladiator-git-history-rename (3 obs)                │
│   - Used git log without --follow flag                   │
│   - git blame misses history after rename                │
│   - git diff ignores renames by default                  │
│ NEW: gladiator-bash-glob-quoting (2 obs)                 │
│   - Unquoted variable caused glob expansion              │
│   - Array expansion without quotes split on spaces       │
└──────────────────────────────────────────────────────────┘

{ groups: [{ write_path, draft_skill, observations }], actions: [...] }
```

The JSON output includes:

- `write_path` — exact path to write each SKILL.md
- `draft_skill` — ready-to-review skill content with frontmatter
- `observations` — full context (before/after, errors) for synthesis
- `actions` — suggestions: write skills, update rules, suggest CLAUDE.md changes
- `existing_skills` — skills that already exist for potential updates

### gladiator_search

Search observations and discovered gladiator-\* skills. No args returns overview stats.

```
⚔ gladiator_search query?=<query> limit?=<number>
  > "Search for git-related observations"
  > "" (empty = stats overview)
```

```
┌─ ⚔ ────────────────────────────────────────────── Stats ─┐
│ Observations: 12 total, 3 unprocessed                    │
│ Skills: 2 created                                        │
│   gladiator-git-history-rename: git log, blame, follow   │
│   gladiator-bash-quoting: variable expansion, spaces     │
│                                                          │
│ 3 observations ready for gladiator_reflect               │
└──────────────────────────────────────────────────────────┘
```

```
┌─ ⚔ ────────────────────────────────────────────── Found ─┐
│ "git" — 3 observations, 1 skill                          │
│   Used git log without --follow flag (2d ago)             │
│   git blame misses history after rename (1d ago)          │
│   git diff ignores renames by default (3h ago)            │
│   Skill: gladiator-git-history-rename                     │
└───────────────────────────────────────────────────────────┘

{ observations: [{ id, summary, context, tags }], matching_skills: [...] }
```

**Status indicators:**

- **Recorded** — Observation saved to JSONL
- **Skipped** — Duplicate detected (summary hash match)
- **Reflected** — Observations clustered into draft skills
- **Found** — Search results with matching observations and skills
- **Stats** — Overview of observations and skills
- **Empty** — No unprocessed observations to reflect on

## usage

Gladiator learns from mistakes and patterns. The more it observes, the better skills it writes.

**What gets observed (via hooks or agent):**

- Error resolutions — what failed and what fixed it
- User corrections — before/after when you correct Claude
- Repeated patterns — same kind of fix across sessions
- Tool-specific issues — Bash quoting, git flags, ESM/CJS

**What Claude can improve about itself:**

- Write new skills (`~/.claude/skills/gladiator-*/SKILL.md`)
- Update existing rules (`~/.claude/rules/*.md`)
- Suggest CLAUDE.md changes (shows diff, user approves)
- Flag hook/plugin improvements

**Skill output format (native Claude Code skill):**

```yaml
---
name: gladiator-git-follow-renames
description: "git log incomplete history, missing commits after rename, git log --follow"
user-invocable: false
confidence: 0.5
observations: 3
---
## Problem
git log stops at rename point.

## Solution
`git log --follow -- <file>`

## Example
Before: `git log -3 -- src/new-name.ts` → 1 commit
After: `git log -3 --follow -- src/new-name.ts` → full history
```

The `description` field is packed with error strings and symptoms — Claude Code's native skill matching finds it automatically in future sessions.

## methodology

How [claude-gladiator-mcp](https://github.com/Vvkmnn/claude-gladiator-mcp) [works](https://github.com/Vvkmnn/claude-gladiator-mcp/tree/master/src):

```
                ⚔ claude-gladiator-mcp
                ══════════════════════


      observe (capture)        reflect (synthesize)
      ─────────────────        ────────────────────

          INPUT                   UNPROCESSED
            │                         │
            ▼                         ▼
       ┌──────────┐             ┌──────────┐
       │  Quality │             │  Cluster │
       │   Gate   │             │  by Tags │
       └────┬─────┘             └────┬─────┘
            │                        │
            ▼                        ▼
       ┌──────────┐             ┌──────────┐
       │  Dedup   │             │  Draft   │
       │  (SHA)   │             │ SKILL.md │
       └────┬─────┘             └────┬─────┘
            │                        │
            ▼                        ▼
       ┌──────────┐             ┌──────────┐
       │  JSONL   │             │  Agent   │
       │  Append  │             │ Reviews  │
       └────┬─────┘             └────┬─────┘
            │                        │
            ▼                        ▼
         OUTPUT                  SKILL.md
                            ~/.claude/skills/


      storage: ~/.claude/gladiator/
      ────────────────────────────
      observations.jsonl    append-only observations

      output: ~/.claude/skills/gladiator-*/
      ──────────────────────────────────────
      SKILL.md              native Claude Code skills
```

**Core design:**

- **No API key needed** — MCP clusters observations, the current Claude session synthesizes skills (your existing subscription does the work)
- **No background processes** — analysis runs on-demand via `gladiator_reflect`, not every N minutes
- **No custom retrieval** — skills go to `~/.claude/skills/` where Claude Code loads them natively by description matching
- **Quality gates at observation time** — dedup by SHA-256 hash, min 20 chars, corrections need before+after
- **Confidence scoring** — starts 0.3, +0.1 per reinforcing observation, capped at 1.0

**File access:**

- Observations: `~/.claude/gladiator/observations.jsonl` (append-only, one JSON per line)
- Skills: `~/.claude/skills/gladiator-*/SKILL.md` (standard location, Claude loads automatically)
- Zero database dependencies (flat files only, no external services)
- Never leaves your machine

## development

```bash
git clone https://github.com/Vvkmnn/claude-gladiator-mcp && cd claude-gladiator-mcp
npm install && npm run build
```

**Package requirements:**

- **Node.js**: >=20.0.0 (ES modules)
- **npm**: >=10.0.0 (package-lock v3)
- **Runtime**: `@modelcontextprotocol/sdk`, `zod`
- **Zero external databases** — works with `bunx`

**Development workflow:**

```bash
npm run build          # TypeScript compilation
npm run watch          # Watch mode with tsc --watch
node dist/index.js     # Run MCP server directly (stdio)
```

**Contributing:**

- Fork the repository and create feature branches
- Test all three tools (observe, reflect, search) before submitting PRs
- Follow TypeScript strict mode and [MCP protocol](https://modelcontextprotocol.io/specification)

## roadmap

### plugin (claude-emporium)

The [claude-emporium](https://github.com/Vvkmnn/claude-emporium) plugin will add hooks and a `/reflect` command for full automation:

```
claude-emporium/plugins/claude-gladiator/
├── .claude-plugin/plugin.json
├── hooks/
│   ├── hooks.json
│   ├── observe.js          # PostToolUse(Edit|Write|Bash): capture errors to JSONL via MCP
│   └── stop.js             # Stop: nudge /reflect if 3+ unprocessed observations
├── commands/
│   └── reflect.md          # /reflect: calls gladiator_reflect, agent writes skills
└── skills/
    └── claude-gladiator/SKILL.md
```

- **observe.js** — PostToolUse hook on Edit, Write, Bash. Captures errors and corrections automatically
- **stop.js** — Stop hook that reminds to `/reflect` when unprocessed observations pile up
- **reflect.md** — `/reflect` command that calls `gladiator_reflect`, reviews draft skills, writes final SKILL.md files, and considers rule/CLAUDE.md updates

## license

[MIT](LICENSE)

---

![Pollice Verso by Jean-Leon Gerome, 1872](https://upload.wikimedia.org/wikipedia/commons/thumb/2/27/Jean-Leon_Gerome_Pollice_Verso.jpg/800px-Jean-Leon_Gerome_Pollice_Verso.jpg)

_[Pollice Verso](https://en.wikipedia.org/wiki/Pollice_Verso_(G%C3%A9r%C3%B4me)) (1872) by Jean-Leon Gerome — "Ave Imperator, morituri te salutant." Emperor [Claudius](https://en.wikipedia.org/wiki/Claudius) is the only emperor where this salute is [documented](https://penelope.uchicago.edu/Thayer/E/Roman/Texts/Suetonius/12Caesars/Claudius*.html)._
