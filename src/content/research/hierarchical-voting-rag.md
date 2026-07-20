---
title: "Hierarchical Voting Retrieval-Augmented Generation: Separating Retrieval Granularity from Generation Context"
summary: "A retrieval architecture that separates small embedded retrieval atoms from larger coherent parent resources selected through deterministic atom-to-parent voting, improving answer traceability and quality across complex source sets."
status: "published"
year: 2026
category: "artificial_intelligence_computer_science"
creditType: "author"
publicationType: "Preprint"
publisher: "Zenodo"
doi: "10.5281/zenodo.20472565"
doiUrl: "https://doi.org/10.5281/zenodo.20472565"
projectLink: "/projects/atom/"
priority: 1
published: true
seo:
  title: "Hierarchical Voting RAG — Published Research"
  description: "A published retrieval architecture using hierarchical evidence selection and voting to improve answer traceability across complex document corpora."
---

Standard RAG pipelines retrieve candidate passages and pass them to a generation model. This works adequately for simple queries over uniform corpora, but breaks down when sources are numerous, heterogeneous, or contradictory — the model receives a flat context and must make implicit tradeoffs that are difficult to inspect or audit.

Hierarchical Voting RAG introduces a structural separation between retrieval granularity and generation context. Evidence is gathered as small, precisely embedded atoms optimized for retrieval precision. Those atoms then vote deterministically for larger parent resources — sections, document segments, or full documents — that are selected as generation context. The result is answers that are more robustly grounded in the available sources and more traceable: you can follow which atoms voted for which parent resources, and why weaker candidates were deprioritized.

Parent-resource selection runs without intermediate LLM calls, using deterministic scoring such as reciprocal-rank-style voting, best-child selection, or normalized voting across retrieved atom counts. A pilot benchmark on fetal echocardiography research documents compared Flat RAG, best-child parent selection, HV-RAG, and HV-RAG Top-N under identical atom-level retrieval, with parent-resource methods improving expected-answer matching over Flat RAG.

The architecture grew out of practical retrieval work on [Atom](/projects/atom/) and generalizes to any domain where retrieval quality and provenance matter more than response speed.

Published May 2026. Available at [doi.org/10.5281/zenodo.20472565](https://doi.org/10.5281/zenodo.20472565).
