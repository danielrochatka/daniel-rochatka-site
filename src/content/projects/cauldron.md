---
title: "Cauldron"
summary: "A reusable, versioned platform foundation that combines Django for administrative and application capabilities with Astro for public rendering, installed and updated as a dependency rather than copied per project."
category: "Platform Architecture"
status: "Active"
featured: true
priority: 2
published: true
externalUrl: "https://github.com/danielrochatka/cauldron"
seo:
  title: "Cauldron — CMS and AI Application Platform Foundation"
  description: "Cauldron is Procyonsoft's versioned CMS and application platform built on Django and Astro, installed as a dependency and extended through site-owned modules and themes."
---

Cauldron is the platform foundation underlying Procyonsoft's CMS and application work. The core architectural decision is that websites and applications install Cauldron as a versioned dependency and update it like any other package — they do not copy or fork it per project.

## Architecture

Cauldron separates into two cooperating packages:

**`cauldron` (Python, version 0.1.0)** — The Django administrative and application layer. Sites install this as a Python package and extend it through supported module and settings contracts. Django 5.x is a dependency; it is not vendored or embedded into Cauldron.

**`@procyonsoft/cauldron-astro` (TypeScript, version 0.1.0)** — The Astro public-rendering integration. Sites install this as an npm package and use it as the build-time bridge between Cauldron's content model and Astro's static output pipeline. Astro 4–5 is a peer dependency.

## Content Model

Cauldron uses the filesystem and Git history as the canonical source of truth for ordinary CMS content. Content is stored as Markdown files with YAML front matter, validated against JSON Schema definitions, and identified by canonical content hashes. This means:

- No SQL database is required to author, version, or restore site content
- Django-side edit tooling and Astro build-time tooling compute byte-identical hashes over the same on-disk layout
- SQL databases, search indexes, vector indexes, and caches are derivative or operational systems, not canonical content stores

An optional workspace scratch area supports change sets, snapshots, and file locks for teams that need staging or approval workflows before committing content to the main content repository.

## Extension Model

Cauldron defines explicit contracts for Python-side modules and settings, and TypeScript-side Astro integration points. Sites own their modules, themes, content, media, and configuration; Cauldron-owned code stays in the core packages. This boundary is what makes the versioned-dependency model workable: sites can update Cauldron without rewriting their own extensions, and Cauldron can evolve without being coupled to any particular site's layout or content structure.

## Stack

Python 3.11+, Django 5.x, Astro 4–5, TypeScript, Hatchling/Hatchling packaging, pytest, pytest-django, AJV, gray-matter, Markdown with YAML front matter, JSON Schema, Git.

## Scope Boundaries

The current foundation covers the content model, repository routing, canonical hashing, module and theme contracts, and the Django-Astro integration. AI administration, LLM integrations, media management, RAG/vector capabilities, deployment tooling, billing, and tenancy are planned as future or deferred modules — they are not present in the foundation and are not implied by the 0.1.0 release.

Cauldron is the infrastructure foundation for [Procyonsoft](https://procyonsoft.com) products. Repository at [github.com/danielrochatka/cauldron](https://github.com/danielrochatka/cauldron).
