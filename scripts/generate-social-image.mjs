import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svgPath = path.join(root, 'public', 'og-card.svg');
const outPath = path.join(root, 'public', 'og-card.jpg');

const svg = readFileSync(svgPath);
await sharp(svg).resize(1200, 630).jpeg({ quality: 92 }).toFile(outPath);
console.log(`Social image written: ${outPath}`);
