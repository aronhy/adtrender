import { describe, expect, it } from 'vitest';
import { freeToolsCatalog } from './catalog';
import { pathToPrototypeHash, prototypeHashToPath } from './routing';

describe('approved free tool routing boundary', () => {
  it('maps the directory, guide and all 17 approved tools in both directions', () => {
    expect(freeToolsCatalog).toHaveLength(17);
    const pairs = [
      ['/tools', '#/'], ['/tools/guide', '#/guide'],
      ...freeToolsCatalog.map(tool => [`/tools/${tool.slug}`, `#/tools/${tool.slug}`]),
    ];
    for (const [path, hash] of pairs) {
      expect(pathToPrototypeHash(path)).toBe(hash);
      expect(prototypeHashToPath(hash)).toBe(path);
    }
  });

  it('normalizes pathname trailing slashes and falls back for unknown tools', () => {
    expect(pathToPrototypeHash('/tools/')).toBe('#/');
    expect(pathToPrototypeHash('/tools/guide/')).toBe('#/guide');
    expect(pathToPrototypeHash('/tools/not-an-approved-tool')).toBe('#/');
    expect(pathToPrototypeHash('/tools/roas-calculator/extra')).toBe('#/');
  });

  it('does not turn external, workspace, encoded or fragment input into a tool route', () => {
    for (const hash of ['https://example.com', '//example.com', '/tools', '#/app/ads', '#/tools/no-such-tool', '#/tools/%72oas-calculator', '#/guide?next=https://example.com', '#/tools/roas-calculator#main', '#main', '#result-panel']) {
      expect(prototypeHashToPath(hash)).toBeNull();
    }
    for (const path of ['https://example.com/tools/roas-calculator', '//example.com/tools/roas-calculator', '/app/ads', '/tools/%72oas-calculator', '/tools/guide?next=/app']) {
      expect(pathToPrototypeHash(path)).toBe('#/');
    }
  });
});
