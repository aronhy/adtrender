# Free tools sources

Implemented first batch: six local calculators, an original template Hook generator, and a fixed official-library navigation helper. No external advertising or store dataset is included.

- `big.js` **7.0.1**, MIT, Michael Mclaughlin. Used for decimal arithmetic; formulas and presentation are implemented in this repository. Upstream reviewed commit: [cdbc06f](https://github.com/MikeMcl/big.js/tree/cdbc06f1d5ae9be429b97f433ee884cf9ad28072). The complete notice is redistributed with the frontend at [`/licenses/big.js-MIT.txt`](../../apps/web/public/licenses/big.js-MIT.txt).
- `@types/big.js` **7.0.0**, MIT, DefinitelyTyped contributors; development-time type definitions only. Exact versions and integrity are recorded in `apps/web/package-lock.json`.
- Hook sentences in `hooks.ts` are original Chinese/English templates. [SkillMedev/skills social-hook-generator](https://github.com/SkillMedev/skills/blob/97a13607d669157a4a16d5ba79b77f208319f7b9/skills/social-hook-generator/SKILL.md), MIT, informed the general pattern categories; no upstream sentence, performance number or skill implementation was copied. The output is deterministic template text, not an AI generation or translation service.
- Official advertising-library links use fixed platform-owned origins. User queries are never used as an external hostname. Unverified platform search parameters are not invented; the user can copy their keyword into the official site. AdTrender's own search still requires its normal account and workspace access.

All calculator inputs and results stay in the current page. Tool pages do not load Google Analytics or Clarity; existing consent-based first-party page/CTA events contain only allowed canonical paths, not form contents. Crossing between marketing, tools and authenticated pages requires a full navigation so previous marketing scripts cannot observe tool inputs.

The broader candidate investigation remains in [the research note](../research/2026-10-22-free-tools-open-source.md). Shopify detection/export libraries, external fingerprint databases and browser-extension implementations have not been imported in this first batch.
