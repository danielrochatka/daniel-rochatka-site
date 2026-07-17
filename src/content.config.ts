import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const projects = defineCollection({
  loader: glob({ base: './src/content/projects', pattern: '**/*.md' }),
  schema: z.object({
    title: z.string().min(1),
    summary: z.string().min(1),
    category: z.string().min(1),
    status: z.enum(['Active', 'Research', 'Incubation']),
    featured: z.boolean().default(false),
    priority: z.number().int().nonnegative().default(100),
    published: z.boolean().default(false),
    externalUrl: z.string().url().optional(),
    doiUrl: z.string().url().optional(),
    seo: z.object({
      title: z.string().min(1),
      description: z.string().min(1).max(170),
    }),
  }),
});

const research = defineCollection({
  loader: glob({ base: './src/content/research', pattern: '**/*.md' }),
  schema: z.object({
    title: z.string().min(1),
    summary: z.string().min(1),
    status: z.enum(['published', 'developing', 'manuscript']),
    year: z.number().int().optional(),
    doiUrl: z.string().url().optional(),
    repositoryUrl: z.string().url().optional(),
    priority: z.number().int().nonnegative().default(100),
    published: z.boolean().default(false),
    seo: z.object({
      title: z.string().min(1),
      description: z.string().min(1).max(170),
    }),
  }),
});

const notes = defineCollection({
  loader: glob({ base: './src/content/notes', pattern: '**/*.md' }),
  schema: z.object({
    title: z.string().min(1),
    date: z.coerce.date(),
    draft: z.boolean().default(true),
    summary: z.string().optional(),
  }),
});

const quotes = defineCollection({
  loader: glob({ base: './src/content/quotes', pattern: '**/*.md' }),
  schema: z.object({
    text: z.string().min(1),
    attribution: z.string().min(1),
    source: z.string().optional(),
    date: z.coerce.date().optional(),
    published: z.boolean().default(false),
  }),
});

export const collections = { projects, research, notes, quotes };
