#!/usr/bin/env node
/**
 * Rename this plugin everywhere it is named, then verify the result.
 *
 * The package name is not decorative: the browser bundle's `id` must equal the
 * package name that the host scans (a mismatch means the client bundle never
 * loads), and `cordis.patch.yml` inserts a loader row by that same name. A
 * rename that touches only `package.json` therefore produces a plugin that
 * silently does not appear — which is exactly what this script exists to
 * prevent.
 *
 * Usage:
 *   node tools/rename.mjs @you/dsh-token-gauge
 *   node tools/rename.mjs @you/dsh-token-gauge --dry-run
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const next = args.find((a) => !a.startsWith('--'));

if (!next) {
	console.error('usage: node tools/rename.mjs <package-name> [--dry-run]');
	process.exit(1);
}
if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(next)) {
	console.error(`invalid npm package name: ${next}`);
	process.exit(1);
}

const manifestPath = join(root, 'package.json');
const previous = JSON.parse(readFileSync(manifestPath, 'utf8')).name;

// The localStorage prefix and the bundle id both follow the package name, so
// two differently named builds never share remembered panel geometry.
const slug = next.replace(/^@[^/]+\//, '');
const oldSlug = previous.replace(/^@[^/]+\//, '');

/** One file's textual substitutions. */
const edits = [
	{
		file: 'package.json',
		apply: (text) => {
			const manifest = JSON.parse(text);
			manifest.name = next;
			return JSON.stringify(manifest, null, 2) + '\n';
		}
	},
	{
		file: 'lib/client.js',
		// the ModuleLoader entry id must equal the package name
		apply: (text) => text.replace(new RegExp(`id: "${previous}"`, 'g'), `id: "${next}"`)
	},
	{
		file: 'lib/client.js',
		// the style marker names the exact package so two builds never collide
		apply: (text) => text.replace(new RegExp(`data-plugin", "${previous}"`, 'g'), `data-plugin", "${next}"`)
	},
	{
		file: 'lib/client.js',
		apply: (text) => text.replace(new RegExp(oldSlug, 'g'), slug)
	},
	{
		file: 'cordis.patch.yml',
		apply: (text) => text.replace(new RegExp(`name: '${previous}'`, 'g'), `name: '${next}'`)
	},
	{
		file: 'setup.sh',
		apply: (text) => text.replace(new RegExp(oldSlug, 'g'), slug)
	},
	{
		file: 'restart-and-verify.sh',
		apply: (text) => text.replace(new RegExp(oldSlug, 'g'), slug)
	},
	{
		file: 'test/harness.mjs',
		apply: (text) => text.replace(new RegExp(previous, 'g'), next).replace(new RegExp(oldSlug, 'g'), slug)
	}
];

const changed = new Map();
for (const edit of edits) {
	const path = join(root, edit.file);
	const before = changed.get(edit.file) ?? readFileSync(path, 'utf8');
	const after = edit.apply(before);
	if (after !== before) changed.set(edit.file, after);
}

if (changed.size === 0) {
	console.log(`nothing to do: already named ${next}`);
	process.exit(0);
}

for (const [file, text] of changed) {
	console.log(`${dryRun ? 'would rewrite' : 'rewriting'} ${file}`);
	if (!dryRun) writeFileSync(join(root, file), text);
}

if (dryRun) process.exit(0);

// A rename is only correct if the bundle id and the loader row agree with the
// manifest, so prove it here rather than discovering it in the browser.
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const bundleId = /id: "([^"]+)"/.exec(readFileSync(join(root, 'lib/client.js'), 'utf8'))?.[1];
const rowName = /name: '([^']+)'/.exec(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'))?.[1];
const problems = [];
if (bundleId !== manifest.name) problems.push(`bundle id "${bundleId}" != package name "${manifest.name}"`);
if (rowName !== manifest.name) problems.push(`loader row "${rowName}" != package name "${manifest.name}"`);
const harness = readFileSync(join(root, 'test/harness.mjs'), 'utf8');
const staleNames = [...harness.matchAll(/'(\S*?)'\s*\)/g)].map((m) => m[1]).filter((n) => n.includes('token-') && n !== manifest.name);
if (harness.includes(previous) || staleNames.length) {
	problems.push(`test/harness.mjs still references a previous name`);
}

if (problems.length) {
	console.error('\nrename left the package inconsistent:');
	for (const problem of problems) console.error('  - ' + problem);
	process.exit(1);
}

console.log(`\nrenamed ${previous} -> ${next}`);
console.log('running the regression harness to confirm nothing else broke…');
execFileSync(process.execPath, [join(root, 'test/harness.mjs')], { stdio: 'inherit' });
