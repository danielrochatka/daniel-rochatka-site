/**
 * Content schema validation tests.
 *
 * These tests parse Markdown frontmatter directly from the filesystem using
 * the same node:test runner as the contact-service tests. They guard against:
 *   - Duplicate entry IDs within a collection
 *   - Missing required frontmatter fields
 *   - Invalid credit-type claims on biomedical entries
 *   - DOI URL format consistency
 *   - PMID/PMCID only appearing on journal articles
 *   - ORCID and Scholar profile links in the footer
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

// ── Frontmatter parser ───────────────────────────────────────────────────────

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const yaml = match[1];
  const result = {};
  for (const line of yaml.split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*"?(.+?)"?\s*$/);
    if (kv) {
      const val = kv[2].trim().replace(/^"(.*)"$/, '$1');
      // Attempt numeric coercion
      result[kv[1]] = isNaN(val) || val === '' ? val : Number(val);
    }
    // Boolean literals
    const boolMatch = line.match(/^(\w[\w-]*):\s*(true|false)\s*$/);
    if (boolMatch) result[boolMatch[1]] = boolMatch[2] === 'true';
  }
  return result;
}

async function loadCollection(collectionName) {
  const dir = join(ROOT, 'src', 'content', collectionName);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
  return Promise.all(
    files.map(async (file) => {
      const content = await readFile(join(dir, file), 'utf-8');
      const id = basename(file, '.md');
      return { id, file, data: parseFrontmatter(content) };
    }),
  );
}

// ── Research collection tests ────────────────────────────────────────────────

test('research: no duplicate entry IDs', async () => {
  const entries = await loadCollection('research');
  const ids = entries.map((e) => e.id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, `Duplicate research IDs found: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`);
});

test('research: all published entries have title, summary, and status', async () => {
  const entries = await loadCollection('research');
  const published = entries.filter((e) => e.data.published === true);
  for (const entry of published) {
    assert.ok(entry.data.title, `${entry.id}: missing title`);
    assert.ok(entry.data.summary, `${entry.id}: missing summary`);
    assert.ok(entry.data.status, `${entry.id}: missing status`);
  }
});

test('research: status values are in the allowed enum', async () => {
  const allowed = new Set(['published', 'developing', 'manuscript', 'filed']);
  const entries = await loadCollection('research');
  for (const entry of entries) {
    if (entry.data.status) {
      assert.ok(
        allowed.has(entry.data.status),
        `${entry.id}: invalid status "${entry.data.status}"`,
      );
    }
  }
});

test('research: creditType values are in the allowed enum', async () => {
  const allowed = new Set([
    'author',
    'acknowledged_scientific_contributor',
    'related_scientific_publication',
    'inventor',
  ]);
  const entries = await loadCollection('research');
  for (const entry of entries) {
    if (entry.data.creditType) {
      assert.ok(
        allowed.has(entry.data.creditType),
        `${entry.id}: invalid creditType "${entry.data.creditType}"`,
      );
    }
  }
});

test('research: doiUrl fields start with https://doi.org/', async () => {
  const entries = await loadCollection('research');
  for (const entry of entries) {
    if (entry.data.doiUrl) {
      assert.ok(
        entry.data.doiUrl.startsWith('https://doi.org/'),
        `${entry.id}: doiUrl must start with https://doi.org/ — got "${entry.data.doiUrl}"`,
      );
    }
  }
});

test('research: author entries with status=published have a doiUrl or note via publicationType', async () => {
  const entries = await loadCollection('research');
  for (const entry of entries) {
    if (entry.data.creditType === 'author' && entry.data.status === 'published') {
      // Provisional patents are author-filed without a DOI — allow via publicationType
      const isPatent = entry.data.publicationType === 'Provisional patent application';
      if (!isPatent) {
        assert.ok(
          entry.data.doiUrl,
          `${entry.id}: authored published entry must have a doiUrl`,
        );
      }
    }
  }
});

test('research: placental-thickness entry is acknowledged_scientific_contributor, not author', async () => {
  const entries = await loadCollection('research');
  const entry = entries.find((e) => e.id === 'placental-thickness-jcm');
  assert.ok(entry, 'placental-thickness-jcm entry not found');
  assert.equal(
    entry.data.creditType,
    'acknowledged_scientific_contributor',
    'placental-thickness-jcm must not claim authorship',
  );
  assert.notEqual(
    entry.data.creditType,
    'author',
    'placental-thickness-jcm must not claim authorship',
  );
});

test('research: fetal-lung entry is related_scientific_publication, not author', async () => {
  const entries = await loadCollection('research');
  const entry = entries.find((e) => e.id === 'fetal-lung-biomedicines');
  assert.ok(entry, 'fetal-lung-biomedicines entry not found');
  assert.equal(
    entry.data.creditType,
    'related_scientific_publication',
    'fetal-lung-biomedicines must not claim authorship or acknowledged contribution',
  );
  assert.notEqual(
    entry.data.creditType,
    'author',
    'fetal-lung-biomedicines must not claim authorship',
  );
  assert.notEqual(
    entry.data.creditType,
    'acknowledged_scientific_contributor',
    'fetal-lung-biomedicines must not claim acknowledged contribution',
  );
});

test('research: PMID and PMCID only appear on journal articles', async () => {
  const entries = await loadCollection('research');
  for (const entry of entries) {
    if (entry.data.pmid || entry.data.pmcid) {
      assert.equal(
        entry.data.publicationType,
        'Journal article',
        `${entry.id}: pmid/pmcid should only appear on journal articles`,
      );
    }
  }
});

test('research: HV-RAG entry has correct DOI', async () => {
  const entries = await loadCollection('research');
  const hvRag = entries.find((e) => e.id === 'hierarchical-voting-rag');
  assert.ok(hvRag, 'hierarchical-voting-rag entry not found');
  assert.equal(hvRag.data.doiUrl, 'https://doi.org/10.5281/zenodo.20472565');
});

test('research: Vocarum entry has correct DOI (not the superseded 16636108)', async () => {
  const entries = await loadCollection('research');
  const vocarum = entries.find((e) => e.id === 'vocarum');
  assert.ok(vocarum, 'vocarum research entry not found');
  assert.equal(vocarum.data.doiUrl, 'https://doi.org/10.5281/zenodo.17148702');
  assert.doesNotMatch(
    vocarum.data.doiUrl ?? '',
    /16636108/,
    'vocarum must not reference the superseded DOI 16636108',
  );
});

test('research: category values are in the allowed enum', async () => {
  const allowed = new Set([
    'artificial_intelligence_computer_science',
    'physics_cosmology',
    'biomedical_fetal_medicine',
    'patents_inventions',
  ]);
  const entries = await loadCollection('research');
  for (const entry of entries) {
    if (entry.data.category) {
      assert.ok(
        allowed.has(entry.data.category),
        `${entry.id}: invalid category "${entry.data.category}"`,
      );
    }
  }
});

test('research: vocarum-patent is filed under patents_inventions as inventor', async () => {
  const entries = await loadCollection('research');
  const patent = entries.find((e) => e.id === 'vocarum-patent');
  assert.ok(patent, 'vocarum-patent entry not found');
  assert.equal(patent.data.category, 'patents_inventions');
  assert.equal(patent.data.creditType, 'inventor');
  assert.equal(patent.data.status, 'filed');
});

// ── Projects collection tests ─────────────────────────────────────────────────

test('projects: no duplicate entry IDs', async () => {
  const entries = await loadCollection('projects');
  const ids = entries.map((e) => e.id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, `Duplicate project IDs: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`);
});

test('projects: all published entries have title, summary, category, and status', async () => {
  const entries = await loadCollection('projects');
  const published = entries.filter((e) => e.data.published === true);
  for (const entry of published) {
    assert.ok(entry.data.title, `${entry.id}: missing title`);
    assert.ok(entry.data.summary, `${entry.id}: missing summary`);
    assert.ok(entry.data.category, `${entry.id}: missing category`);
    assert.ok(entry.data.status, `${entry.id}: missing status`);
  }
});

test('projects: vocarum project has correct DOI (not the superseded 16636108)', async () => {
  const entries = await loadCollection('projects');
  const vocarum = entries.find((e) => e.id === 'vocarum');
  assert.ok(vocarum, 'vocarum project not found');
  if (vocarum.data.doiUrl) {
    assert.doesNotMatch(
      vocarum.data.doiUrl,
      /16636108/,
      'vocarum project must not reference the superseded DOI 16636108',
    );
  }
});

test('projects: cauldron project is present and published', async () => {
  const entries = await loadCollection('projects');
  const cauldron = entries.find((e) => e.id === 'cauldron');
  assert.ok(cauldron, 'cauldron project not found');
  assert.equal(cauldron.data.published, true, 'cauldron project must be published');
  assert.ok(cauldron.data.title, 'cauldron project must have a title');
});

// ── Footer profile link test (file content) ───────────────────────────────────

test('footer: contains ORCID profile link', async () => {
  const footer = await readFile(join(ROOT, 'src', 'components', 'Footer.astro'), 'utf-8');
  assert.ok(
    footer.includes('orcid.org/0009-0004-1007-748X'),
    'Footer must contain ORCID profile link',
  );
});

test('footer: contains Google Scholar profile link', async () => {
  const footer = await readFile(join(ROOT, 'src', 'components', 'Footer.astro'), 'utf-8');
  assert.ok(
    footer.includes('scholar.google.com/citations?user=bIoEhOAAAAAJ'),
    'Footer must contain Google Scholar profile link',
  );
});
