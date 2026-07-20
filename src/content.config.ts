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
    status: z.enum(['published', 'developing', 'manuscript', 'filed']),
    year: z.number().int().optional(),
    doiUrl: z.string().url().optional(),
    repositoryUrl: z.string().url().optional(),
    priority: z.number().int().nonnegative().default(100),
    published: z.boolean().default(false),
    category: z.enum([
      'artificial_intelligence_computer_science',
      'physics_cosmology',
      'biomedical_fetal_medicine',
      'patents_inventions',
    ]).optional(),
    creditType: z.enum([
      'author',
      'acknowledged_scientific_contributor',
      'related_scientific_publication',
      'research_contributor',
      'inventor',
    ]).optional(),
    doi: z.string().optional(),
    pmid: z.string().optional(),
    pmcid: z.string().optional(),
    journal: z.string().optional(),
    publisher: z.string().optional(),
    publicationType: z.string().optional(),
    projectLink: z.string().optional(),
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
