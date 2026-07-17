export type Project = {
  title: string;
  summary: string;
  category: string;
  status: 'Active' | 'Research' | 'Incubation';
  href?: string;
};

export const projects: Project[] = [
  {
    title: 'Atom',
    summary: 'An AI orchestration and expert-system platform combining planning, retrieval, verification, review, memory, and operational traceability.',
    category: 'Applied AI',
    status: 'Active',
  },
  {
    title: 'AxiomMesh',
    summary: 'A memory-first architecture for persistent agents, evolving memory objects, provenance, and model-independent identity across changing latent spaces.',
    category: 'AI Architecture',
    status: 'Research',
  },
  {
    title: 'Vocarum',
    summary: 'A consensus-journalism system designed to model agreement, disagreement, evidence, and bias without flattening meaningful differences.',
    category: 'Information Systems',
    status: 'Research',
    href: 'https://doi.org/10.5281/zenodo.16636108',
  },
  {
    title: 'PersonalGuard',
    summary: 'An AI-first personal communications platform focused on identity, filtering, prioritization, reply assistance, and privacy-preserving control.',
    category: 'Personal Infrastructure',
    status: 'Incubation',
  },
  {
    title: 'VComplete',
    summary: 'Centralized versioning for people who need durable document history, structured change, and collaboration without adopting developer tooling.',
    category: 'Product Systems',
    status: 'Incubation',
  },
  {
    title: 'Transformational Physics Framework',
    summary: 'An exploratory physics framework that treats transformations and their conservation as primary, rather than beginning from energy as the primitive.',
    category: 'Foundational Research',
    status: 'Research',
  },
];
