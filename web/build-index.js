#!/usr/bin/env node
// Generates posts/index.json from the .md files in posts/.
// Run it before building the container: node tools/build-index.js
// Files starting with "_" (e.g. _template.md) are ignored.
const fs = require('fs');
const path = require('path');

// Works whether this file sits next to posts/ or inside a tools/ folder
const candidates = [path.join(__dirname, 'posts'), path.join(__dirname, '..', 'posts')];
const dir = candidates.find((d) => fs.existsSync(d));
if (!dir) {
  console.error('Could not find a posts/ folder next to this script or one level up.');
  process.exit(1);
}
const slugs = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
  .map((f) => f.slice(0, -3))
  .filter((slug) => {
    const ok = /^[\w-]+$/.test(slug);
    if (!ok) console.warn(`Skipping "${slug}.md": use only letters, numbers, - and _ in filenames`);
    return ok;
  })
  .sort();

fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(slugs, null, 2) + '\n');
console.log(`posts/index.json: ${slugs.length} post(s) -> ${slugs.join(', ')}`);