/**
 * Gladiator MCP — Type definitions
 *
 * Zod schemas for observations and tool inputs, plus shared interfaces
 * used across the MCP server.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Artifact types that gladiator can recommend creating or updating. */
export const ARTIFACT_TYPES = ['skill', 'rule', 'hook', 'agent'] as const;

/** Sources an observation can originate from. */
export const OBSERVATION_SOURCES = ['manual', 'hook', 'conversation', 'session'] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];

// ---------------------------------------------------------------------------
// Schemas — persisted observation record
// ---------------------------------------------------------------------------

/** Optional structured context attached to an observation. */
export const ContextSchema = z.object({
  tool: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  error: z.string().optional(),
});

/**
 * Full observation record as stored in JSONL.
 *
 * Fields added after v0.1.0 use `.default()` so older records
 * parse without errors (backwards compatibility).
 */
export const ObservationSchema = z.object({
  id: z.string(),
  ts: z.string(),
  session: z.string(),
  summary: z.string().min(20),
  context: ContextSchema.optional(),
  tags: z.array(z.string()),
  recommendation: z.string().default(''),
  artifact_type: z.enum(ARTIFACT_TYPES).default('rule'),
  source: z.enum(OBSERVATION_SOURCES).default('manual'),
  session_ref: z.string().optional(),
  processed: z.boolean(),
});

export type Observation = z.infer<typeof ObservationSchema>;

// ---------------------------------------------------------------------------
// Schemas — MCP tool inputs
// ---------------------------------------------------------------------------

/** Input for `gladiator_observe`. Only `summary` is required. */
export const ObserveInputSchema = z.object({
  summary: z.string().min(20),
  context: ContextSchema.optional(),
  tags: z.array(z.string()).default([]),
  recommendation: z.string().optional(),
  artifact_type: z.enum(ARTIFACT_TYPES).optional(),
  source: z.enum(OBSERVATION_SOURCES).optional(),
  session_ref: z.string().optional(),
});

export type ObserveInput = z.infer<typeof ObserveInputSchema>;

/** Input for `gladiator_reflect`. Both fields are optional. */
export const ReflectInputSchema = z.object({
  query: z.string().optional(),
  limit: z.number().default(50),
});

export type ReflectInput = z.infer<typeof ReflectInputSchema>;

// ---------------------------------------------------------------------------
// Shared interfaces
// ---------------------------------------------------------------------------

/** Filter for reading observations from storage. */
export interface ObservationFilter {
  readonly processed?: boolean;
  readonly limit?: number;
}

/** A cluster of related observations grouped by tag overlap. */
export interface ObservationGroup {
  readonly tags: readonly string[];
  readonly observations: readonly Observation[];
  readonly artifact_type: ArtifactType;
  readonly suggested_name: string;
}

/** An existing rule, hook, or skill discovered on disk. */
export interface ExistingArtifact {
  readonly type: 'rule' | 'hook' | 'skill';
  readonly name: string;
  readonly path: string;
  readonly keywords: string[];
}

/**
 * Corpus-wide word frequency index for IDF-weighted scoring.
 *
 * Words appearing in more than `threshold` artifacts are considered
 * generic and filtered from matching. Remaining words are weighted
 * by `1 / docFreq` so rare words score higher.
 */
export interface CorpusIndex {
  readonly docFreq: Map<string, number>;
  readonly threshold: number;
  readonly total: number;
}
