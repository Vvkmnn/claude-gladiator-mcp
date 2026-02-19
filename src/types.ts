import { z } from "zod";

// Observation — a single thing worth remembering
export const ObservationSchema = z.object({
  id: z.string(),
  ts: z.string(),
  session: z.string(),
  summary: z.string().min(20),
  context: z
    .object({
      tool: z.string().optional(),
      before: z.string().optional(),
      after: z.string().optional(),
      error: z.string().optional(),
    })
    .optional(),
  tags: z.array(z.string()),
  processed: z.boolean(),
});

export type Observation = z.infer<typeof ObservationSchema>;

// Input schemas for MCP tools
export const ObserveInputSchema = z.object({
  summary: z.string().min(20),
  context: z
    .object({
      tool: z.string().optional(),
      before: z.string().optional(),
      after: z.string().optional(),
      error: z.string().optional(),
    })
    .optional(),
  tags: z.array(z.string()).default([]),
});

export type ObserveInput = z.infer<typeof ObserveInputSchema>;

export const ReflectInputSchema = z.object({
  limit: z.number().default(50),
});

export type ReflectInput = z.infer<typeof ReflectInputSchema>;

export const SearchInputSchema = z.object({
  query: z.string().optional(),
  limit: z.number().default(20),
});

export type SearchInput = z.infer<typeof SearchInputSchema>;
