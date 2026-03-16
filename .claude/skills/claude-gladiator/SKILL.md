---
name: claude-gladiator
description: Use after tool failures or user corrections to record patterns, and when accumulated observations need clustering into rule/hook/skill recommendations. Builds project-specific knowledge that persists across sessions.
---

# Claude Gladiator

Record mistakes and corrections. Cluster them into actionable recommendations for rules, hooks, and skills.

## When to Observe

**After tool failures:**
- Edit returned `old_string not unique` → Record disambiguation strategy
- Bash command failed → Record correct approach
- Any tool error with a non-obvious fix → Record what worked

**After user corrections:**
- User corrected file structure, naming, or approach → Record the convention
- User preferred a different strategy → Record the preference

```
gladiator_observe(
  summary: "Edit failed on config.ts — 3 identical import blocks, fixed by including surrounding function context",
  tags: ["edit", "disambiguation"],
  context: { error: "old_string not unique", before: "used import line only", after: "included 3 lines above" }
)
```

## When to Reflect

**When observations have accumulated** → `gladiator_reflect()` clusters unprocessed observations, scans existing `~/.claude/rules/`, `~/.claude/hooks/`, `~/.claude/skills/`, and recommends UPDATE to existing artifacts or CREATE new ones.

**Searching past patterns** → `gladiator_reflect(query: "edit")` finds all observations matching a topic.

**Checking stats** → `gladiator_reflect()` with nothing unprocessed shows observation counts by type.

## Quick Reference

| Tool | When | What it does |
|------|------|-------------|
| `gladiator_observe` | After failures, corrections, discoveries | Record pattern with summary, tags, context. Deduped by SHA-256. |
| `gladiator_reflect` | After accumulating observations | Cluster → scan existing config → recommend artifact changes. |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Only observing failures | Also observe corrections, conventions, non-obvious solutions |
| Vague summaries | Include the specific error message, what was tried, what worked |
| Creating new rules when existing ones apply | Reflect scans existing artifacts — prefer UPDATE over CREATE |
