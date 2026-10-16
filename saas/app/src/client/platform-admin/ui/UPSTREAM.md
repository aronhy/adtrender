# Button source

Adapted from [shadcn/ui Button](https://github.com/shadcn-ui/ui/blob/c257f688cf4de7ec10cc1be84cad29cd4631182c/apps/v4/registry/new-york-v4/ui/button.tsx).

- Upstream commit: `c257f688cf4de7ec10cc1be84cad29cd4631182c`
- Retrieved source SHA-256: `79dd6f75f8136394442202d6b8b922fb269eaad0a5dba579397c9d5b41f893bb`
- License: MIT, preserved in `LICENSE.shadcn-ui.md`.
- Adaptation: local semantic CSS token classes, direct `@radix-ui/react-slot`, `clsx` + `tailwind-merge` in place of upstream project utility.
- This is a copied component, not an admin template.

## Charts

Recharts 3.10.1 (MIT), retained in `LICENSE.recharts.md`. Only same-source query results are passed to charts; fixtures live exclusively in test scripts. Charts are mounted on the client and render equal-height loading blocks during SSR.
