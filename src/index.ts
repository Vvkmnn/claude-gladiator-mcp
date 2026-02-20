#!/usr/bin/env node

/**
 * Gladiator MCP Server
 *
 * A continuous-learning MCP server for Claude Code. Records observations
 * about patterns, clusters them, and recommends whether to update existing
 * rules/hooks/skills or create new ones — using IDF-weighted corpus scoring
 * to avoid false-positive matches against generic keywords.
 *
 * Tools:
 *   gladiator_observe — Record a pattern worth learning from
 *   gladiator_reflect — Query, cluster, and get recommendations
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "crypto";
import { createRequire } from "module";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";

import {
  ObserveInputSchema,
  ReflectInputSchema,
  type ArtifactType,
  type CorpusIndex,
  type ExistingArtifact,
  type Observation,
  type ObservationFilter,
  type ObservationGroup,
  type ObserveInput,
  type ReflectInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CLAUDE_DIR = join(homedir(), ".claude");
const BASE_DIR = join(CLAUDE_DIR, "gladiator");
const OBS_FILE = join(BASE_DIR, "observations.jsonl");

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function ensureDir(): void {
  if (!existsSync(BASE_DIR)) mkdirSync(BASE_DIR, { recursive: true });
}

/** Append a single observation to the JSONL store. */
function appendObservation(obs: Observation): void {
  ensureDir();
  appendFileSync(OBS_FILE, JSON.stringify(obs) + "\n");
}

/**
 * Read observations from disk with optional filtering.
 *
 * Applies backwards-compat defaults for fields added after initial
 * release (`recommendation`, `artifact_type`, `source`).
 */
function readObservations(filter?: ObservationFilter): Observation[] {
  if (!existsSync(OBS_FILE)) return [];

  const lines = readFileSync(OBS_FILE, "utf-8").split("\n").filter(Boolean);
  let obs: Observation[] = [];

  for (const line of lines) {
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      obs.push({
        recommendation: "",
        artifact_type: "rule",
        source: "manual",
        ...raw,
      } as Observation);
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

/** Mark a set of observation IDs as processed in the JSONL store. */
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

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/** SHA-256 prefix hash of a lowercased, trimmed summary. */
function hashSummary(summary: string): string {
  return createHash("sha256").update(summary.toLowerCase().trim()).digest("hex").slice(0, 8);
}

/** Collect hashes of the most recent `count` observations. */
function recentHashes(count: number): Set<string> {
  return new Set(readObservations({ limit: count }).map((o) => hashSummary(o.summary)));
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Auto-classify an observation's artifact type from its tags and context. */
function classifyArtifact(tags: string[], context?: ObserveInput["context"]): ArtifactType {
  const tagStr = tags.join(" ").toLowerCase();
  if (/\b(automat|hook|pre-tool|post-tool|trigger)\b/.test(tagStr)) return "hook";
  if (/\b(agent|subagent|review|audit)\b/.test(tagStr)) return "agent";
  if (context?.before && context.after) return "skill";
  return "rule";
}

/** Generate a default recommendation when none is provided. */
function defaultRecommendation(summary: string, context?: ObserveInput["context"]): string {
  if (context?.after) return `Next time: ${context.after}`;
  if (context?.error) return `Avoid: ${context.error}`;
  return `Address: ${summary}`;
}

// ---------------------------------------------------------------------------
// Existing artifact discovery
// ---------------------------------------------------------------------------

/** Extract unique words (>3 chars) from text for keyword matching. */
function extractKeywords(content: string): string[] {
  const words = content
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  return [...new Set(words)];
}

/**
 * Scan `~/.claude/` for existing rules, hooks, and skills.
 *
 * Returns artifact metadata with extracted keywords for each,
 * used to determine whether new observations should update an
 * existing artifact rather than create a new one.
 */
function discoverExistingArtifacts(): ExistingArtifact[] {
  const artifacts: ExistingArtifact[] = [];

  const scanDir = (
    dir: string,
    type: ExistingArtifact["type"],
    filter: (f: string) => boolean,
    getPath: (f: string) => string,
  ): void => {
    if (!existsSync(dir)) return;
    try {
      for (const file of readdirSync(dir).filter(filter)) {
        const path = getPath(file);
        if (!existsSync(path)) continue;
        const name = file.replace(/\.[^.]+$/, "");
        const content = readFileSync(path, "utf-8");
        artifacts.push({ type, name, path, keywords: extractKeywords(content) });
      }
    } catch {
      // skip on permission errors
    }
  };

  // Rules: ~/.claude/rules/*.md
  scanDir(
    join(CLAUDE_DIR, "rules"),
    "rule",
    (f) => f.endsWith(".md"),
    (f) => join(CLAUDE_DIR, "rules", f),
  );

  // Hooks: ~/.claude/hooks/*
  scanDir(
    join(CLAUDE_DIR, "hooks"),
    "hook",
    (f) => !f.startsWith("."),
    (f) => join(CLAUDE_DIR, "hooks", f),
  );

  // Skills: ~/.claude/skills/*/SKILL.md
  const skillsDir = join(CLAUDE_DIR, "skills");
  if (existsSync(skillsDir)) {
    try {
      for (const dir of readdirSync(skillsDir)) {
        const skillFile = join(skillsDir, dir, "SKILL.md");
        if (existsSync(skillFile)) {
          const content = readFileSync(skillFile, "utf-8");
          artifacts.push({
            type: "skill",
            name: dir,
            path: skillFile,
            keywords: extractKeywords(content),
          });
        }
      }
    } catch {
      // skip
    }
  }

  return artifacts;
}

// ---------------------------------------------------------------------------
// Corpus-aware IDF scoring
// ---------------------------------------------------------------------------

/**
 * Build a document-frequency index across all discovered artifacts.
 *
 * For each unique word, counts how many artifacts contain it.
 * Words in >40% of artifacts are "generic" and get filtered from
 * matching — this replaces hardcoded stopword lists with a
 * self-maintaining, corpus-aware approach.
 */
function buildCorpusIndex(artifacts: ExistingArtifact[]): CorpusIndex {
  const docFreq = new Map<string, number>();
  for (const artifact of artifacts) {
    for (const word of new Set(artifact.keywords)) {
      docFreq.set(word, (docFreq.get(word) ?? 0) + 1);
    }
  }
  return {
    docFreq,
    threshold: artifacts.length * 0.4,
    total: artifacts.length,
  };
}

/**
 * Find existing artifacts that overlap with an observation group.
 *
 * Uses IDF-weighted scoring: rare words (unique to few artifacts) score
 * higher than common ones. Words in >40% of artifacts are filtered as
 * generic. A direct name match adds a strong +5 bonus.
 *
 * Threshold of 3.0 means roughly:
 *   - 3 unique-to-one-artifact keyword matches, OR
 *   - 1 name match alone (5.0), OR
 *   - 9 keywords each in 3 artifacts (9 * 0.33 = 3.0)
 */
function findOverlappingArtifacts(
  group: ObservationGroup,
  existing: ExistingArtifact[],
  index: CorpusIndex,
): ExistingArtifact[] {
  // Build word set from group's tags, summaries, and recommendations
  const groupWords = new Set([
    ...group.tags.map((t) => t.toLowerCase()),
    ...group.observations.flatMap((o) =>
      o.summary
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3),
    ),
    ...group.observations.flatMap((o) =>
      o.recommendation
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3),
    ),
  ]);

  const isRelevant = (word: string): boolean => (index.docFreq.get(word) ?? 0) <= index.threshold;

  const scored = existing.map((artifact) => {
    let score = 0;
    const artifactSet = new Set(artifact.keywords.filter(isRelevant));

    for (const word of groupWords) {
      if (isRelevant(word) && artifactSet.has(word)) {
        score += 1 / (index.docFreq.get(word) ?? 1);
      }
    }

    // Direct name match is a strong signal
    const nameMatch = group.tags.some(
      (t) => artifact.name.includes(t.toLowerCase()) || t.toLowerCase().includes(artifact.name),
    );
    if (nameMatch) score += 5;

    return { artifact, score };
  });

  return scored
    .filter((s) => s.score >= 3.0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((s) => s.artifact);
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

/**
 * Cluster observations into groups by tag overlap (Jaccard > 0.3).
 *
 * Observations with overlapping tags are merged into the same group.
 * Each group gets a majority-vote artifact type and a slug name
 * derived from its most common tags.
 */
function clusterObservations(obs: Observation[]): ObservationGroup[] {
  if (obs.length === 0) return [];

  const groups = new Map<string, Observation[]>();

  for (const o of obs) {
    const key = o.tags.length > 0 ? o.tags.sort().join(",") : `untagged-${o.id}`;
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

  const result: ObservationGroup[] = [];

  for (const [, groupObs] of groups) {
    if (groupObs.length === 0) continue;

    const allTags = [...new Set(groupObs.flatMap((o) => o.tags))];
    const firstObs = groupObs[0];
    if (!firstObs) continue; // unreachable: length > 0 checked above
    const slug =
      allTags
        .slice(0, 2)
        .join("-")
        .replace(/[^a-z0-9-]/gi, "")
        .slice(0, 25) || `unnamed-${firstObs.id.slice(-4)}`;

    // Majority vote for artifact_type
    const typeCounts = new Map<ArtifactType, number>();
    for (const o of groupObs) {
      typeCounts.set(o.artifact_type, (typeCounts.get(o.artifact_type) ?? 0) + 1);
    }
    let majorityType: ArtifactType = "rule";
    let maxCount = 0;
    for (const [type, count] of typeCounts) {
      if (count > maxCount) {
        majorityType = type;
        maxCount = count;
      }
    }

    result.push({
      tags: allTags,
      observations: groupObs,
      artifact_type: majorityType,
      suggested_name: slug,
    });
  }

  return result.sort((a, b) => b.observations.length - a.observations.length);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Render content lines inside a bordered box with a status label. */
function formatBox(content: string[], status: string, width = 70): string {
  const topLeft = "┌─ ⚔ ";
  const topRight = ` ${status} ─┐`;
  const dashCount = width - topLeft.length - topRight.length;
  const topBorder = topLeft + "─".repeat(Math.max(0, dashCount)) + topRight;
  const bottomBorder = "└" + "─".repeat(width - 2) + "┘";
  const maxContent = width - 4;

  const lines = [topBorder];
  for (const line of content) {
    const truncated = line.length > maxContent ? line.slice(0, maxContent - 1) + "…" : line;
    lines.push(`│ ${truncated.padEnd(maxContent)} │`);
  }
  lines.push(bottomBorder);

  return lines.join("\n");
}

/** Human-readable relative timestamp (e.g. "3h ago", "2d ago"). */
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

// ---------------------------------------------------------------------------
// MCP tool definitions
// ---------------------------------------------------------------------------

const observeToolDef = {
  name: "gladiator_observe",
  description:
    "Record a pattern worth learning from, with optional recommendation and artifact type. Deduplicates by summary hash.",
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
      recommendation: {
        type: "string",
        description: "What to do about this pattern (auto-generated if omitted)",
      },
      artifact_type: {
        type: "string",
        enum: ["skill", "rule", "hook", "agent"],
        description: "Suggested artifact type (auto-classified if omitted)",
      },
      source: {
        type: "string",
        enum: ["manual", "hook", "conversation", "session"],
        description: "Where this observation came from (default: manual)",
      },
      session_ref: {
        type: "string",
        description:
          "Session file reference when observing from conversation history (e.g., project-dir/session-id)",
      },
    },
    required: ["summary"],
  },
};

const reflectToolDef = {
  name: "gladiator_reflect",
  description:
    "Query and cluster observations. No args = stats overview. With query = filtered search. Unprocessed observations are clustered by tag overlap with recommendations.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Keyword to filter observations by summary, tags, or recommendation",
      },
      limit: {
        type: "number",
        description: "Max observations to analyze (default 50)",
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

function handleObserve(input: ObserveInput): string {
  // Quality gate: corrections need both before and after
  if (input.context?.before && !input.context.after) {
    return formatBox(["Corrections need both 'before' and 'after' context."], "Skipped");
  }

  // Dedup check against recent observations
  const hash = hashSummary(input.summary);
  if (recentHashes(100).has(hash)) {
    return formatBox([`Duplicate observation (hash: ${hash})`], "Skipped");
  }

  const artifact_type = input.artifact_type ?? classifyArtifact(input.tags, input.context);
  const recommendation =
    input.recommendation ?? defaultRecommendation(input.summary, input.context);
  const source = input.source ?? "manual";

  const obs: Observation = {
    id: `obs_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
    ts: new Date().toISOString(),
    session: process.env.CLAUDE_SESSION_ID ?? "unknown",
    summary: input.summary,
    context: input.context,
    tags: input.tags,
    recommendation,
    artifact_type,
    source,
    session_ref: input.session_ref,
    processed: false,
  };

  appendObservation(obs);

  const content = [obs.summary, `Recommend (${artifact_type}): ${recommendation.slice(0, 55)}`];
  if (obs.tags.length > 0) content.push(`Tags: ${obs.tags.join(", ")}`);

  const allObs = readObservations();
  const unprocessed = allObs.filter((o) => !o.processed).length;
  content.push(`Backlog: ${unprocessed} unprocessed of ${allObs.length} total`);

  return formatBox(content, "Recorded");
}

function handleReflect(input: ReflectInput): string {
  const allObs = readObservations();

  // --- Query mode: search across all observations ---
  if (input.query) {
    return handleReflectQuery(allObs, input as ReflectInput & { query: string });
  }

  // --- Stats mode: overview + cluster unprocessed ---
  const unprocessed = allObs.filter((o) => !o.processed);

  const byType = new Map<string, number>();
  for (const o of allObs) {
    const t = o.artifact_type;
    byType.set(t, (byType.get(t) ?? 0) + 1);
  }

  if (unprocessed.length === 0) {
    return handleReflectStats(allObs, byType);
  }

  return handleReflectCluster(unprocessed, byType, input.limit);
}

// ---------------------------------------------------------------------------
// Reflect sub-handlers (extracted for clarity)
// ---------------------------------------------------------------------------

/** Search observations matching a query string. Caller guarantees `input.query` is set. */
function handleReflectQuery(
  allObs: Observation[],
  input: ReflectInput & { query: string },
): string {
  const q = input.query.toLowerCase();
  const limit = input.limit;

  const matching = allObs
    .filter(
      (o) =>
        o.summary.toLowerCase().includes(q) ||
        o.tags.some((t) => t.toLowerCase().includes(q)) ||
        o.recommendation.toLowerCase().includes(q) ||
        o.context?.error?.toLowerCase().includes(q) ||
        o.source.toLowerCase().includes(q) ||
        o.session_ref?.toLowerCase().includes(q),
    )
    .slice(-limit);

  const content = [
    `"${input.query}" — ${matching.length} observation${matching.length !== 1 ? "s" : ""}`,
  ];
  for (const o of matching.slice(-5)) {
    content.push(`  ${o.summary.slice(0, 50)} (${formatAge(o.ts)})`);
  }
  if (matching.length > 5) {
    content.push(`  ... +${matching.length - 5} more`);
  }

  return `${formatBox(content, "Found")}\n\n${JSON.stringify(
    {
      query: input.query,
      matching_observations: matching.length,
      observations: matching.map(summarizeObservation),
    },
    null,
    2,
  )}`;
}

/** Pure stats when no unprocessed observations remain. */
function handleReflectStats(allObs: Observation[], byType: Map<string, number>): string {
  const content = [`Observations: ${allObs.length} total, 0 unprocessed`];
  for (const [type, count] of byType) {
    content.push(`  ${type}: ${count}`);
  }

  return `${formatBox(content, "Stats")}\n\n${JSON.stringify(
    {
      total_observations: allObs.length,
      unprocessed: 0,
      processed: allObs.length,
      by_artifact_type: Object.fromEntries(byType),
      recent_observations: allObs.slice(-5).map(summarizeObservation),
    },
    null,
    2,
  )}`;
}

/** Cluster unprocessed observations and recommend actions. */
function handleReflectCluster(
  unprocessed: Observation[],
  byType: Map<string, number>,
  limit: number,
): string {
  const limited = unprocessed.slice(-limit);
  const groups = clusterObservations(limited);

  // Discover existing artifacts and build IDF index
  const existing = discoverExistingArtifacts();
  const corpusIndex = buildCorpusIndex(existing);

  // Mark as processed
  markProcessed(limited.map((o) => o.id));

  // Annotate groups with overlapping artifacts
  const annotatedGroups = groups.map((g) => {
    const overlaps = findOverlappingArtifacts(g, existing, corpusIndex);
    return { ...g, overlapping_artifacts: overlaps };
  });

  // Box output
  const content = [
    `${limited.length} observations → ${groups.length} group${groups.length !== 1 ? "s" : ""}`,
    `${existing.length} existing artifacts scanned (IDF-weighted)`,
    "",
  ];

  for (const g of annotatedGroups) {
    const firstOverlap = g.overlapping_artifacts[0];
    const action = firstOverlap ? `UPDATE ${firstOverlap.name}` : `NEW ${g.artifact_type}`;
    content.push(`${action}: ${g.suggested_name} (${g.observations.length} obs)`);

    for (const o of g.observations.slice(0, 3)) {
      content.push(`  - ${o.recommendation.slice(0, 55)}`);
    }
    if (g.observations.length > 3) {
      content.push(`  ... +${g.observations.length - 3} more`);
    }
  }

  return `${formatBox(content, "Reflected")}\n\n${JSON.stringify(
    {
      observations_analyzed: limited.length,
      groups_found: groups.length,
      existing_artifacts_scanned: existing.length,
      by_artifact_type: Object.fromEntries(byType),
      groups: annotatedGroups.map((g) => ({
        suggested_name: g.suggested_name,
        artifact_type: g.artifact_type,
        tags: g.tags,
        action: g.overlapping_artifacts.length > 0 ? "update" : "create",
        update_targets: g.overlapping_artifacts.map((a) => ({
          type: a.type,
          name: a.name,
          path: a.path,
        })),
        observations: g.observations.map(summarizeObservation),
      })),
      actions: [
        "PREFER updating existing artifacts over creating new ones",
        "Consolidate related observations into a single change when possible",
        "Only create new artifacts when no existing one covers the topic",
        "Generalize recommendations — avoid one-off rules for single incidents",
        "The user decides what to act on — gladiator only recommends",
      ],
    },
    null,
    2,
  )}`;
}

/** Extract a consistent summary shape from an observation for JSON output. */
function summarizeObservation(o: Observation): Record<string, unknown> {
  return {
    id: o.id,
    ts: o.ts,
    summary: o.summary,
    recommendation: o.recommendation,
    artifact_type: o.artifact_type,
    context: o.context,
    tags: o.tags,
    processed: o.processed,
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require("../package.json") as { version: string };

const SERVER_INSTRUCTIONS = `⚔️ Gladiator — Continuous Learning

Observe patterns, reflect on them, evolve your workflow:
• gladiator_observe(summary, context?, tags) — Record something worth learning
• gladiator_reflect(query?, limit?) — Query and cluster observations into recommendations

Recommendations point to ~/.claude/rules/, hooks/, and skills/ — apply them by editing those files directly.

Observe patterns worth learning from:
- Tool failures: Edit old_string not unique, Bash command errors, MCP timeouts
- Corrections: User rejected a tool call, same file edited 3+ times, rewind triggered
- Codebase patterns: Architectural conventions, reusable utilities, naming styles
- Configuration: Better tool settings, MCP capabilities, workflow optimizations
- Decisions: Why approach A over B, trade-offs considered, edge cases found
- Conversation analysis: Patterns found by reviewing past session transcripts

Do NOT observe: generic programming knowledge, trivial successes, transient errors (network timeouts)

IMPORTANT — Consolidation over creation:
When reflecting, gladiator scans existing rules (~/.claude/rules/), hooks (~/.claude/hooks/), and skills (~/.claude/skills/) and recommends UPDATING existing artifacts when observations overlap with what's already there. Only recommend creating new artifacts when no existing one covers the topic. Generalize — a single rule update covering 5 observations is better than 5 new files.`;

const server = new Server(
  { name: "claude-gladiator-mcp", version: SERVER_VERSION },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [observeToolDef, reflectToolDef],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    if (name === "gladiator_observe") {
      result = handleObserve(ObserveInputSchema.parse(args));
    } else if (name === "gladiator_reflect") {
      result = handleReflect(ReflectInputSchema.parse(args));
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: "text", text: result }] };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Gladiator MCP v${SERVER_VERSION} running on stdio`);
}

main().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
