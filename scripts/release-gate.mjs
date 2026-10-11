// Decides whether a push to main publishes a new desktop release. Every push
// still builds and validates all six targets; only pushes that change what
// users install get a version. Test, docs and CI-only commits — and commits
// whose message carries "[no release]" — would otherwise publish a duplicate.
import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const NOT_SHIPPED = [/^tests\//, /^distribution\//, /^docs\//, /^\.github\//, /\.md$/i, /^electron\/[^/]+\.test\.cjs$/, /^scripts\/smoke-[^/]+\.mjs$/];

export function shipped(file) {
  return !NOT_SHIPPED.some((pattern) => pattern.test(file));
}

export function decide(commits) {
  const files = new Set();
  for (const commit of commits) {
    if (/\[no release\]/i.test(commit.message)) continue;
    for (const file of commit.files) if (shipped(file)) files.add(file);
  }
  return [...files].sort();
}

function commitsSince(tag) {
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  return git('rev-list', range).split('\n').filter(Boolean).map((sha) => ({
    message: git('log', '-1', '--format=%B', sha),
    files: git('diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha).split('\n').filter(Boolean),
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tag = git('tag', '--list', 'v*', '--sort=-v:refname').split('\n')[0] || '';
  const files = tag ? decide(commitsSince(tag)) : ['(first release)'];
  const release = files.length > 0;
  console.log(release
    ? `Publishing: ${files.length} shipped file(s) changed since ${tag || 'the beginning'}:\n  ${files.slice(0, 40).join('\n  ')}`
    : `Not publishing: nothing users install changed since ${tag}. The six builds still validate.`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `release=${release}\n`);
}
