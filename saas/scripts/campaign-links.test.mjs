import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./campaign-links.mjs', import.meta.url));
const baseArgs = ['--channel', 'linkedin', '--campaign', 'launch-202610', '--content', 'post-a'];
const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
const invalid = (args) => {
  const result = run(args);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  // Invalid input must not be copied into output, including secrets or personal data.
  assert.equal(result.stderr, 'Invalid arguments. Run with --help for allowed values.\n');
};

test('generates a complete, lowercase LinkedIn link to the default homepage', () => {
  const result = run(baseArgs);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'https://adtrender.com/?utm_source=linkedin&utm_medium=social&utm_campaign=launch-202610&utm_content=post-a\n');
});

test('uses default-channel-compatible media for each candidate distribution channel', () => {
  const cases = [
    ['linkedin', 'linkedin', 'social'], ['x', 'x', 'social'],
    ['youtube', 'youtube', 'video'], ['reddit', 'reddit', 'social'],
    ['newsletter', 'newsletter', 'email'], ['producthunt', 'producthunt', 'referral'],
    ['hackernews', 'hackernews', 'social'], ['partner', 'partner', 'referral'],
  ];
  for (const [channel, source, medium] of cases) {
    const result = run(['--channel', channel, '--campaign', 'guide-202611', '--content', 'bio-b']);
    assert.equal(result.status, 0, channel);
    assert.equal(result.stdout, `https://adtrender.com/?utm_source=${source}&utm_medium=${medium}&utm_campaign=guide-202611&utm_content=bio-b\n`);
  }
});

test('allows exactly the five currently measured public paths', () => {
  for (const path of ['/', '/pricing', '/help', '/terms', '/privacy']) {
    const result = run([...baseArgs, '--path', path]);
    assert.equal(result.status, 0, path);
    assert.ok(result.stdout.startsWith('https://adtrender.com/'));
    assert.equal(new URL(result.stdout.trim()).pathname, path);
  }
});

test('rejects private, external and noncanonical destinations before URL normalization', () => {
  for (const path of ['/app', '/login', '/auth/callback', '/pricing/', '/app/../', '/%70ricing', '//elsewhere.invalid/', 'https://adtrender.com/', 'https://elsewhere.invalid/', '/?lang=en', '/#main', '/privacy?token=example', '/\\elsewhere.invalid']) {
    invalid([...baseArgs, '--path', path]);
  }
});

test('accepts the documented activity and placement vocabulary', () => {
  for (const campaign of ['launch-202610', 'guide-202611', 'pricing-202612', 'update-202701']) {
    for (const content of ['post-a', 'bio-b', 'video-c', 'email-d', 'comment-e', 'cta-z']) {
      const result = run(['--channel', 'x', '--campaign', campaign, '--content', content]);
      assert.equal(result.status, 0, `${campaign}/${content}`);
      assert.ok(result.stdout.startsWith('https://adtrender.com/'));
      const url = new URL(result.stdout.trim());
      assert.equal(url.searchParams.get('utm_campaign'), campaign);
      assert.equal(url.searchParams.get('utm_content'), content);
    }
  }
});

test('rejects unapproved or malformed campaign labels instead of silently sanitizing them', () => {
  for (const campaign of ['launch', 'Launch-202610', 'launch-202600', 'launch-202613', 'launch-20261001', 'launch-202610\n', 'john-smith', 'customer-13800138000', 'person@example.invalid', 'launch-abcdef0123456789abcdef0123', 'launch-202610&email=person']) {
    invalid(['--channel', 'linkedin', '--campaign', campaign, '--content', 'post-a']);
  }
});

test('rejects freeform content labels including identifier-shaped values', () => {
  for (const content of ['post', 'post-aa', 'post-1', 'post-A', 'post-a\n', 'john-smith', 'post-person@example.invalid', 'post-abcdef0123456789abcdef0123']) {
    invalid(['--channel', 'linkedin', '--campaign', 'launch-202610', '--content', content]);
  }
});

test('rejects unknown channels and source or medium overrides', () => {
  for (const channel of ['google', 'bing', 'LinkedIn', '__proto__', 'constructor', 'person@example.invalid']) {
    invalid(['--channel', channel, '--campaign', 'launch-202610', '--content', 'post-a']);
  }
  for (const flag of ['--source', '--medium', '--utm_term', '--url']) invalid([...baseArgs, flag, 'example']);
});

test('rejects missing, duplicate or stray arguments with no URL output', () => {
  for (const args of [[], ['--channel', 'x'], [...baseArgs, '--path'], [...baseArgs, 'extra'], [...baseArgs, '--channel', 'x'], [...baseArgs, '--path', '/', '--path', '/help'], ['--channel=x', '--campaign', 'launch-202610', '--content', 'post-a'], [...baseArgs, '--help']]) invalid(args);
});

test('provides self-contained usage without generating a campaign link', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /--channel/);
  assert.match(result.stdout, /--campaign/);
  assert.match(result.stdout, /--content/);
  assert.match(result.stdout, /--path/);
  assert.match(result.stdout, /newsletter/);
  assert.doesNotMatch(result.stdout, /utm_source=/);
});
