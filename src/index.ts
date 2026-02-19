#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "crypto";
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  ObserveInputSchema,
  ReflectInputSchema,
  SearchInputSchema,
  type Observation,
  type ObserveInput,
  type ReflectInput,
  type SearchInput,
} from "./types.js";

// Storage paths
const BASE_DIR = join(homedir(), ".claude", "gladiator");
const OBS_FILE = join(BASE_DIR, "observations.jsonl");
const SKILLS_GLOB = join(homedir(), ".claude", "skills");

function ensureDir() {
  if (!existsSync(BASE_DIR)) mkdirSync(BASE_DIR, { recursive: true });
}

// --- Storage ---

function appendObservation(obs: Observation): void {
  ensureDir();
  appendFileSync(OBS_FILE, JSON.stringify(obs) + "\n");
}

function readObservations(filter?: { processed?: boolean; limit?: number }): Observation[] {
  if (!existsSync(OBS_FILE)) return [];
  const lines = readFileSync(OBS_FILE, "utf-8").split("\n").filter(Boolean);
  let obs: Observation[] = [];
  for (const line of lines) {
    try {
      obs.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  if (filter?.processed !== undefined) {
    obs = obs.filter((o) => o.processed === filter.processed);
  }
  if (filter?.limit) {
    obs = obs.slice(-filter.limit);
  }
  return obs;
}

function markProcessed(ids: string[]): void {
  if (!existsSync(OBS_FILE)) return;
  const idSet = new Set(ids);
  const lines = readFileSync(OBS_FILE, "utf-8").split("\n").filter(Boolean);
  const updated = lines.map((line) => {
    try {
      const obs = JSON.parse(line) as Observation;
      if (idSet.has(obs.id)) {
        obs.processed = true;
        return JSON.stringify(obs);
      }
    } catch {
      // keep original
    }
    return line;
  });
  writeFileSync(OBS_FILE, updated.join("\n") + "\n");
}

// --- Dedup ---

function recentHashes(count: number): Set<string> {
  const obs = readObservations({ limit: count });
  return new Set(obs.map((o) => hashSummary(o.summary)));
}

function hashSummary(summary: string): string {
  return createHash("sha256").update(summary.toLowerCase().trim()).digest("hex").slice(0, 8);
}

// --- Skill discovery ---

function discoverSkills(): { name: string; path: string; description: string }[] {
  const skills: { name: string; path: string; description: string }[] = [];
  if (!existsSync(SKILLS_GLOB)) return skills;

  for (const dir of readdirSync(SKILLS_GLOB)) {
    if (!dir.startsWith("gladiator-")) continue;
    const skillFile = join(SKILLS_GLOB, dir, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const content = readFileSync(skillFile, "utf-8");
    // Extract description from YAML frontmatter
    const match = content.match(/description:\s*"?([^"\n]+)"?/);
    skills.push({
      name: dir,
      path: skillFile,
      description: match?.[1] ?? "",
    });
  }
  return skills;
}

// --- Reflect: cluster observations by tag overlap ---

interface ObservationGroup {
  tags: string[];
  observations: Observation[];
  draft_skill: string;
  suggested_name: string;
}

function clusterObservations(obs: Observation[]): ObservationGroup[] {
  if (obs.length === 0) return [];

  // Group by overlapping tags using union-find approach
  const groups: Map<string, Observation[]> = new Map();

  for (const o of obs) {
    const key = o.tags.length > 0 ? o.tags.sort().join(",") : `untagged-${o.id}`;
    // Find existing group with >50% tag overlap
    let merged = false;
    for (const [groupKey, groupObs] of groups) {
      const groupTags = new Set(groupKey.split(","));
      const obsTags = new Set(o.tags);
      const intersection = [...obsTags].filter((t) => groupTags.has(t));
      const union = new Set([...obsTags, ...groupTags]);
      if (union.size > 0 && intersection.length / union.size > 0.3) {
        groupObs.push(o);
        merged = true;
        break;
      }
    }
    if (!merged) {
      groups.set(key, [o]);
    }
  }

  // Convert to output format with draft skills
  const result: ObservationGroup[] = [];
  for (const [key, groupObs] of groups) {
    if (groupObs.length === 0) continue;
    const allTags = [...new Set(groupObs.flatMap((o) => o.tags))];
    const slug = allTags.slice(0, 3).join("-").replace(/[^a-z0-9-]/gi, "") || `unnamed-${groupObs[0].id.slice(-4)}`;
    const summaries = groupObs.map((o) => `- ${o.summary}`).join("\n");
    const examples = groupObs
      .filter((o) => o.context?.before && o.context?.after)
      .slice(0, 2)
      .map(
        (o) =>
          `Before: \`${o.context!.before}\`\nAfter: \`${o.context!.after}\``
      )
      .join("\n\n");
    const errors = groupObs
      .filter((o) => o.context?.error)
      .map((o) => o.context!.error)
      .slice(0, 3);

    const description = [
      ...allTags,
      ...errors,
      ...groupObs.map((o) => o.summary.slice(0, 60)),
    ].join(", ");

    const confidence = Math.min(1.0, 0.2 + groupObs.length * 0.1);

    const draft = `---
name: gladiator-${slug}
description: "${description.replace(/"/g, "'")}"
user-invocable: false
confidence: ${confidence.toFixed(1)}
observations: ${groupObs.length}
---

## Problem
${summaries}

## Solution
[Agent: synthesize a solution from the observations above]
${examples ? `\n## Examples\n${examples}` : ""}
`;

    result.push({
      tags: allTags,
      observations: groupObs,
      draft_skill: draft,
      suggested_name: `gladiator-${slug}`,
    });
  }

  return result.sort((a, b) => b.observations.length - a.observations.length);
}

// --- Formatting ---

function formatBox(content: string[], status: string, width: number = 60): string {
  const topLeft = "┌─ ⚔ ";
  const topRight = ` ${status} ─┐`;
  const dashCount = width - topLeft.length - topRight.length;
  const topBorder = topLeft + "─".repeat(Math.max(0, dashCount)) + topRight;

  const bottomBorder = "└" + "─".repeat(width - 2) + "┘";

  const lines = [topBorder];
  for (const line of content) {
    lines.push(`│ ${line}`);
  }
  lines.push(bottomBorder);
  return lines.join("\n");
}

function formatAge(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

// --- MCP Tool Definitions ---

const observeToolDef = {
  name: "gladiator_observe",
  description:
    "Record an observation worth learning from. Called by hooks on Edit/Write/Bash errors, or directly by the agent. Deduplicates by summary hash.",
  inputSchema: {
    type: "object" as const,
    properties: {
      summary: {
        type: "string",
        description: "1-2 sentence description of what happened (min 20 chars)",
      },
      context: {
        type: "object",
        description: "Optional structured context",
        properties: {
          tool: { type: "string", description: "Tool that triggered this" },
          before: { type: "string", description: "What was tried first" },
          after: { type: "string", description: "What actually worked" },
          error: { type: "string", description: "Exact error message if any" },
        },
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Freeform tags for clustering",
      },
    },
    required: ["summary"],
  },
};

const reflectToolDef = {
  name: "gladiator_reflect",
  description:
    "Analyze unprocessed observations and return clustered groups with draft SKILL.md content. Agent reviews drafts and writes final skills via Write tool. Marks observations as processed.",
  inputSchema: {
    type: "object" as const,
    properties: {
      limit: {
        type: "number",
        description: "Max observations to analyze (default 50)",
      },
    },
  },
};

const searchToolDef = {
  name: "gladiator_search",
  description:
    "Search observations and discovered gladiator-* skills. No args returns overview stats.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Keyword to search for in summaries, tags, and skill descriptions",
      },
      limit: {
        type: "number",
        description: "Max results (default 20)",
      },
    },
  },
};

// --- Tool Handlers ---

function handleObserve(input: ObserveInput): string {
  // Quality gate: corrections need before+after
  if (input.context?.before && !input.context?.after) {
    return formatBox(
      ["Corrections need both 'before' and 'after' context."],
      "Skipped"
    );
  }

  // Dedup check
  const hash = hashSummary(input.summary);
  const recent = recentHashes(100);
  if (recent.has(hash)) {
    return formatBox(
      [`Duplicate observation (hash: ${hash})`],
      "Skipped"
    );
  }

  const obs: Observation = {
    id: `obs_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
    ts: new Date().toISOString(),
    session: process.env.CLAUDE_SESSION_ID ?? "unknown",
    summary: input.summary,
    context: input.context,
    tags: input.tags ?? [],
    processed: false,
  };

  appendObservation(obs);

  const content = [
    obs.summary,
    `ID: ${obs.id}`,
  ];
  if (obs.tags.length > 0) content.push(`Tags: ${obs.tags.join(", ")}`);
  if (obs.context?.tool) content.push(`Tool: ${obs.context.tool}`);
  if (obs.context?.error) content.push(`Error: ${obs.context.error.slice(0, 80)}`);
  if (obs.context?.before) content.push(`Before: ${obs.context.before.slice(0, 60)}`);
  if (obs.context?.after) content.push(`After: ${obs.context.after.slice(0, 60)}`);

  const allObs = readObservations();
  const unprocessed = allObs.filter((o) => !o.processed).length;
  content.push(`Backlog: ${unprocessed} unprocessed of ${allObs.length} total`);

  return formatBox(content, "Recorded");
}

function handleReflect(input: ReflectInput): string {
  const unprocessed = readObservations({ processed: false, limit: input.limit });

  if (unprocessed.length === 0) {
    return formatBox(
      ["No unprocessed observations.", "Use gladiator_observe to record patterns first."],
      "Empty"
    );
  }

  const groups = clusterObservations(unprocessed);
  const existingSkills = discoverSkills();

  // Mark all as processed
  markProcessed(unprocessed.map((o) => o.id));

  // Box: human-readable summary
  const content = [
    `${unprocessed.length} observations → ${groups.length} group${groups.length !== 1 ? "s" : ""}`,
    "",
  ];
  for (const g of groups) {
    const existing = existingSkills.find((s) => s.name === g.suggested_name);
    const action = existing ? "UPDATE" : "NEW";
    content.push(`${action}: ${g.suggested_name} (${g.observations.length} obs)`);
    for (const o of g.observations.slice(0, 3)) {
      content.push(`  - ${o.summary.slice(0, 55)}`);
    }
    if (g.observations.length > 3) {
      content.push(`  ... +${g.observations.length - 3} more`);
    }
  }

  const box = formatBox(content, "Reflected");

  // JSON: full context for Claude to act on
  const data = {
    observations_analyzed: unprocessed.length,
    groups_found: groups.length,
    skills_dir: join(homedir(), ".claude", "skills"),
    rules_dir: join(homedir(), ".claude", "rules"),
    existing_skills: existingSkills.map((s) => ({ name: s.name, path: s.path })),
    groups: groups.map((g) => ({
      suggested_name: g.suggested_name,
      write_path: join(homedir(), ".claude", "skills", g.suggested_name, "SKILL.md"),
      tags: g.tags,
      observation_count: g.observations.length,
      observations: g.observations.map((o) => ({
        id: o.id,
        summary: o.summary,
        context: o.context,
        tags: o.tags,
      })),
      draft_skill: g.draft_skill,
    })),
    actions: [
      "Review each group's draft_skill and write final SKILL.md to write_path",
      "Consider updating existing rules in rules_dir if patterns affect workflow",
      "Consider suggesting CLAUDE.md changes if patterns are fundamental",
    ],
  };

  return `${box}\n\n${JSON.stringify(data, null, 2)}`;
}

function handleSearch(input: SearchInput): string {
  const allObs = readObservations();
  const skills = discoverSkills();

  if (!input.query) {
    // Stats mode
    const unprocessed = allObs.filter((o) => !o.processed).length;
    const content = [
      `Observations: ${allObs.length} total, ${unprocessed} unprocessed`,
      `Skills: ${skills.length} created`,
    ];
    for (const s of skills) {
      content.push(`  ${s.name}: ${s.description.slice(0, 50)}`);
    }
    if (unprocessed > 0) {
      content.push("");
      content.push(`${unprocessed} observations ready for gladiator_reflect`);
    }

    const box = formatBox(content, "Stats");

    const data = {
      total_observations: allObs.length,
      unprocessed,
      processed: allObs.length - unprocessed,
      skills_created: skills.length,
      skills: skills.map((s) => ({ name: s.name, path: s.path, description: s.description })),
      recent_observations: allObs.slice(-5).map((o) => ({
        id: o.id,
        ts: o.ts,
        summary: o.summary,
        tags: o.tags,
        processed: o.processed,
      })),
    };

    return `${box}\n\n${JSON.stringify(data, null, 2)}`;
  }

  const q = input.query.toLowerCase();
  const limit = input.limit ?? 20;

  // Search observations
  const matchingObs = allObs
    .filter(
      (o) =>
        o.summary.toLowerCase().includes(q) ||
        o.tags.some((t) => t.toLowerCase().includes(q)) ||
        o.context?.error?.toLowerCase().includes(q)
    )
    .slice(-limit);

  // Search skills
  const matchingSkills = skills.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q)
  );

  const content = [
    `"${input.query}" — ${matchingObs.length} observation${matchingObs.length !== 1 ? "s" : ""}, ${matchingSkills.length} skill${matchingSkills.length !== 1 ? "s" : ""}`,
  ];
  for (const o of matchingObs.slice(-5)) {
    content.push(`  ${o.summary.slice(0, 50)} (${formatAge(o.ts)})`);
  }
  if (matchingObs.length > 5) {
    content.push(`  ... +${matchingObs.length - 5} more`);
  }
  for (const s of matchingSkills) {
    content.push(`  Skill: ${s.name}`);
  }

  const box = formatBox(content, "Found");

  const data = {
    query: input.query,
    matching_observations: matchingObs.length,
    observations: matchingObs.map((o) => ({
      id: o.id,
      ts: o.ts,
      summary: o.summary,
      context: o.context,
      tags: o.tags,
      processed: o.processed,
    })),
    matching_skills: matchingSkills.map((s) => ({
      name: s.name,
      path: s.path,
      description: s.description,
    })),
  };

  return `${box}\n\n${JSON.stringify(data, null, 2)}`;
}

// --- MCP Server ---

const server = new Server(
  { name: "claude-gladiator-mcp", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions: `⚔️ Gladiator — Continuous Learning

Observe patterns, reflect on them, evolve into skills:
• gladiator_observe(summary, context?, tags) — Record something worth learning
• gladiator_reflect(limit?) — Cluster observations into draft skills
• gladiator_search(query?) — Find observations and skills (no args = stats)

Skills are written to ~/.claude/skills/gladiator-*/SKILL.md — Claude Code loads them natively.`,
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [observeToolDef, reflectToolDef, searchToolDef],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    if (name === "gladiator_observe") {
      const input = ObserveInputSchema.parse(args);
      result = handleObserve(input);
    } else if (name === "gladiator_reflect") {
      const input = ReflectInputSchema.parse(args);
      result = handleReflect(input);
    } else if (name === "gladiator_search") {
      const input = SearchInputSchema.parse(args);
      result = handleSearch(input);
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: "text", text: result }] };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Gladiator MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
