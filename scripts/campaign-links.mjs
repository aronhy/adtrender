#!/usr/bin/env node

// Offline only. Keep this path allowlist aligned with site-analytics/publicPage.
const paths = ['/', '/pricing', '/help', '/terms', '/privacy'];
// Media follow GA4's manual default-channel definitions (see the operations doc).
const channels = {
  linkedin: ['linkedin', 'social'],
  x: ['x', 'social'],
  youtube: ['youtube', 'video'],
  reddit: ['reddit', 'social'],
  newsletter: ['newsletter', 'email'],
  producthunt: ['producthunt', 'referral'],
  hackernews: ['hackernews', 'social'],
  partner: ['partner', 'referral'],
};
const help = `Offline AdTrender campaign link generator
Usage: node scripts/campaign-links.mjs --channel CHANNEL --campaign ACTIVITY-YYYYMM --content PLACEMENT-VARIANT [--path PATH]
--channel: ${Object.keys(channels).join(', ')}
--campaign: launch, guide, pricing or update + '-' + YYYYMM (2000-2099, month 01-12)
--content: post, bio, video, email, comment or cta + '-' + one lowercase letter (a-z)
--path: ${paths.join(', ')} (default: /)
Only lowercase controlled labels are allowed. Do not use personal identifiers.
No network requests, credentials, publishing or file writes.
`;

function build(args) {
  const options = new Map();
  const flags = new Set(['--channel', '--campaign', '--content', '--path']);
  if (args.length % 2 !== 0) return null;
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    // Reject duplicates and raw whitespace; never normalize invalid input into a label.
    if (!flags.has(flag) || options.has(flag) || !value || /\s/.test(value)) return null;
    options.set(flag, value);
  }
  const channel = options.get('--channel');
  const campaign = options.get('--campaign') ?? '';
  const content = options.get('--content') ?? '';
  const path = options.get('--path') ?? '/';
  if (!Object.hasOwn(channels, channel) || !paths.includes(path)) return null;
  // A fixed vocabulary prevents names, emails and arbitrary tokens in the URL.
  if (!/^(launch|guide|pricing|update)-20\d{2}(0[1-9]|1[0-2])$/.test(campaign)) return null;
  if (!/^(post|bio|video|email|comment|cta)-[a-z]$/.test(content)) return null;
  const [source, medium] = channels[channel];
  const url = new URL(path, 'https://adtrender.com');
  url.searchParams.set('utm_source', source);
  url.searchParams.set('utm_medium', medium);
  url.searchParams.set('utm_campaign', campaign);
  url.searchParams.set('utm_content', content);
  return url.href;
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write(help);
} else {
  const url = build(args);
  if (url) process.stdout.write(`${url}\n`);
  else {
    // Do not echo invalid arguments: they may contain personal data or credentials.
    process.stderr.write('Invalid arguments. Run with --help for allowed values.\n');
    process.exitCode = 1;
  }
}
