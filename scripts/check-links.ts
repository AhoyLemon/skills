// Fails the build on any link to a GitHub repo that an anonymous visitor can't see, which is how a link into a private repo shows up.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

interface RepoRef {
  slug: string;
  files: Set<string>;
}

const REPO_LINK = /https?:\/\/(?:www\.)?(?:github\.com|raw\.githubusercontent\.com)\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)/g;
const NOT_OWNERS = new Set(['orgs', 'settings', 'features', 'marketplace', 'sponsors', 'apps', 'topics', 'search', 'login', 'about', 'pricing', 'enterprise', 'collections', 'trending', 'notifications', 'new']);
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|woff2?)$/i;

const write = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const trackedFiles = (): string[] =>
  execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((file) => file !== '' && !BINARY.test(file));

const collect = (files: string[]): Map<string, RepoRef> => {
  const repos = new Map<string, RepoRef>();
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(REPO_LINK)) {
      const owner = match[1] ?? '';
      const repo = (match[2] ?? '').replace(/\.git$/, '').replace(/[.]+$/, '');
      if (NOT_OWNERS.has(owner.toLowerCase()) || repo === '') continue;
      const slug = `${owner}/${repo}`;
      const key = slug.toLowerCase();
      const ref = repos.get(key) ?? { slug, files: new Set<string>() };
      ref.files.add(file);
      repos.set(key, ref);
    }
  }
  return repos;
};

const visibleStatus = async (slug: string): Promise<number> => {
  let status = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`https://github.com/${slug}`, { method: 'HEAD', redirect: 'follow' });
      status = response.status;
      if (status < 500 && status !== 429) return status;
    } catch {
      status = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  return status;
};

const main = async (): Promise<void> => {
  const repos = collect(trackedFiles());
  let failed = 0;
  for (const { slug, files } of [...repos.values()].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const status = await visibleStatus(slug);
    if (status >= 200 && status < 400) {
      write(`  ok   ${slug}`);
      continue;
    }
    failed += 1;
    const why = status === 404 ? 'private or missing' : `couldn't check (HTTP ${status || 'no response'})`;
    write(`  FAIL ${slug}: ${why}, linked from ${[...files].join(', ')}`);
  }
  write(failed === 0 ? `\nEvery GitHub repo link is public (${repos.size} checked).` : `\n${failed} GitHub repo link(s) aren't publicly visible. Nothing here may link into a private repo.`);
  process.exitCode = failed === 0 ? 0 : 1;
};

await main();
