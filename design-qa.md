# Antarctic homepage footer QA

final result: passed

## Target and captures

Approved direction: warm charcoal, cream engraved Antarctic icebergs, orange sunset and authentic AdThrender mark. Exact slogan: **Find your next winning ad**. Four navigation columns, rule/copyright/CTA row, and a lower-right upward-opening language menu.

- [Desktop comparison: approved reference left, implementation right](docs/design/antarctic-footer/desktop-comparison.jpg), same 1672 px width, default Simplified Chinese, menu closed. Reference 1672×941; rendered footer 1672×943.
- [Mobile 390×844](docs/design/antarctic-footer/mobile.png).
- [Mobile language menu](docs/design/antarctic-footer/mobile-language-menu.png).

Both reference and rendered screenshot were opened together and visually compared.

## Checks

- Composition: desktop brand/slogan left and four columns right; thin divider and orange research CTA; full-width panorama and lower-right picker match the approved hierarchy.
- Typography/spacing: desktop 21 px navigation headings; mobile 17 px headings and two-column navigation. Native LandingPage tested at 390 and 1672 px; scoped rules prevent existing `.lp h2` typography from overriding footer headings.
- Palette/art: #1a1613 charcoal, cream text/engraving and restrained orange accents. A visible raster top-edge seam was fixed with an image mask, then the comparison was recaptured. No portraits or baked-in UI text.
- Responsive behavior: no horizontal overflow at 390 and 1672 px, including Spanish mobile copy. Mobile popup stays within the viewport and opens above the trigger.
- Interaction: all four existing locales switch the complete legacy homepage provider, hero copy, document language, footer and URL together. Slogan remains English. Locale choice, keyboard arrows/Home/End, Escape/focus return and outside dismissal verified. Destinations use existing routes and retain locale.
- Runtime: browser error/warning log empty; targeted strict TypeScript check including native LandingPage passed. Six focused locale/component tests passed.

## Remaining differences

P0/P1/P2: none. P3: generated landscape contours and browser font rasterization differ slightly from the concept image; accepted without another polish loop.

## Integration and build

`LandingPage` uses `PolarFooter` directly with the existing locale provider. `polar-footer-entry.tsx` is a temporary Cloud compatibility entry restricted to the earlier homepage's HTML footer; it delegates language changes to the existing header provider. It does not modify app/auth/API routes.

Build the four-file static compatibility artifact from a clean commit:

```sh
node scripts/build-polar-footer.mjs --output /tmp/adtrender-footer-artifact
```

The new output directory must not exist. The manifest records the source commit, dirty status, entry paths and SHA256 of every published file. Production activation is a separately guarded footer-only HTML update with backup; the build does not deploy anything.

## Bottom-edge regression (2026-10-18)

The production footer and every ancestor ended at the same document boundary (zero layout gap), but the HTML canvas was white and BODY transparent. Native bottom overscroll and fractional-pixel rounding could therefore expose a white strip. The homepage now gives both root surfaces the footer's #1a1613 background, using `:has(.polar-footer)` so other routes retain their existing background. Browser checks confirm matching HTML/BODY canvas colors at desktop and mobile widths and zero extra space below the footer.
