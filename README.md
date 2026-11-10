# USDM1 hero runtime

WebGL renderer for the USDM1 hero header art (hairline or thicker strokes, depth and cursor response). Configs are made in the M1 Hero Lab generator and exported as Webflow embeds.

## Use

Load a pinned version from jsDelivr:

```html
<div id="hero" style="position:absolute;inset:0;overflow:hidden;background:#121316"></div>
<script type="module">
import { createHero } from 'https://cdn.jsdelivr.net/gh/m1x-design/usdm1-hero-runtime@v1.4.0/runtime/m1-hero.min.js';
createHero(document.getElementById('hero'), { concept: 'waves' });
</script>
```

Paste the config JSON from the generator in place of `{ concept: 'waves' }`.

## Versions

Always load a tagged version (`@v1.4.0`), never a branch, so published pages don't change when the runtime does. To release a change: update `runtime/m1-hero.js`, commit, tag a new version, then update the URL in the generator's hosted embed and in Webflow.

Load `m1-hero.min.js` on live pages: jsDelivr minifies `runtime/m1-hero.js` automatically, so there is no build step. Use `m1-hero.js` when you need readable code for debugging.

Three.js r169 loads from jsDelivr as a dependency.

## Changelog

- **v1.4.0:** 21 concepts from the Figma Primary - Hero page, grouped as Pages, Use cases, Institutions and Roles. Institutions and Roles concepts use one 2:3 layout at every breakpoint. The original concepts are renamed (for example, Crossing Waves is now Repo Cash Leg); their config ids are unchanged, so existing embeds keep working.
- **v1.3.0:** Ecosystem concept (`frames`) and its preset.
- **v1.2.0:** stroke fill (`look.fill`: `solid`, `gradient` or `alternate`). Gradient shapes fade from full strength to clear across their own extent, toward `look.gradAngle`, reaching clear at `look.gradReach` × the extent. The back stroke only draws with a solid fill.
- **v1.1.2:** new defaults: front stroke #D5E3F6 at 0.7 opacity, back stroke #8DADD3, legibility band 0.8.
- **v1.1.1:** vignette removed (always off, even in configs saved with one), and editing a config can no longer change the built-in defaults.
- **v1.1.0:** stroke width (`look.width`, 1 to 3, where 1 is the original hairline), corner radius for Ledger Bars (`params.radius`), transparent snapshots, and no scroll response.
- **v1.0.0:** first release.
