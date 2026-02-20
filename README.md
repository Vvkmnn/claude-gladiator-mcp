# claude-gladiator-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that helps [Claude Code](https://docs.anthropic.com/en/docs/claude-code) learn from its own mistakes. Observe patterns during work, then reflect to get recommendations for updating your rules, hooks, and skills.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)

## Install

Requirements: [Claude Code](https://claude.ai/code)

**From shell:**

```bash
claude mcp add claude-gladiator-mcp -- npx claude-gladiator-mcp
```

**From any MCP-compatible client** (Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "gladiator": {
      "command": "npx",
      "args": ["claude-gladiator-mcp"]
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `gladiator_observe` | Record a pattern worth learning from |
| `gladiator_reflect` | Cluster observations and get recommendations |

### `gladiator_observe`

Records a single observation — something that went wrong, a correction, a pattern worth remembering. Deduplicates by summary hash.

```
gladiator_observe(
  summary: string,          // what happened (min 20 chars)
  tags?: string[],          // freeform tags for clustering
  recommendation?: string,  // what to do next time (auto-generated if omitted)
  artifact_type?: string,   // "rule" | "skill" | "hook" | "agent" (auto-classified if omitted)
  source?: string,          // "manual" | "hook" | "conversation" | "session"
  session_ref?: string,     // session file reference for conversation analysis
  context?: {               // structured context
    tool?: string,          //   which tool triggered this
    before?: string,        //   what was tried first
    after?: string,         //   what actually worked
    error?: string          //   exact error message
  }
)
```

### `gladiator_reflect`

With no arguments: shows stats and clusters unprocessed observations into groups, scanning `~/.claude/rules/`, `~/.claude/hooks/`, and `~/.claude/skills/` to recommend whether to **update an existing artifact** or **create a new one**.

With a `query`: searches all observations by summary, tags, recommendation, or source.

```
gladiator_reflect(
  query?: string,  // keyword search filter
  limit?: number   // max observations to analyze (default: 50)
)
```

## How It Works

1. **Observe** patterns as you work — tool failures, corrections, codebase conventions, decisions
2. **Reflect** periodically to cluster observations and get recommendations
3. **Act** on recommendations by updating existing rules/hooks/skills or creating new ones

Gladiator uses **IDF-weighted corpus scoring** to match observation groups against existing artifacts. Words appearing in >40% of your artifacts are automatically filtered as generic, so matches are based on domain-specific keywords rather than common words like "code" or "function". This prevents false-positive matches without requiring a hardcoded stopword list.

### What to Observe

- **Tool failures**: Edit `old_string` not unique, Bash command errors, MCP timeouts
- **Corrections**: User rejected a tool call, same file edited 3+ times
- **Codebase patterns**: Architectural conventions, naming styles, reusable utilities
- **Configuration**: Better tool settings, MCP capabilities, workflow optimizations
- **Decisions**: Why approach A over B, trade-offs considered, edge cases found

### What NOT to Observe

- Generic programming knowledge
- Trivial successes
- Transient errors (network timeouts)

## Storage

Observations are stored as JSONL in `~/.claude/gladiator/observations.jsonl`.

## Development

```bash
git clone https://github.com/Vvkmnn/claude-gladiator-mcp.git
cd claude-gladiator-mcp
npm install
npm run build
```

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript |
| `npm run dev` | Watch mode |
| `npm run lint` | ESLint check |
| `npm run format` | Prettier format |
| `npm run typecheck` | Type check without emitting |

## License

MIT
