# Build 5: Marketing studio

## Part 1 (v5.0.0): websites + content calendar
- **Mia (designer agent, Sonnet 5)** writes single-page, mobile-first sites from a brief (`save_site`). Drafts are stored in the DB.
- **Safety:** every page is sanitized on save (no scripts, iframes, embeds, forms, event handlers, `javascript:` links, meta refresh, `<base>`, or stylesheets other than Google Fonts). Previews render in a sandboxed iframe with scripts disabled. Saving drafts is allowed after web research (drafts are private); **publishing is always an approval** (public content).
- **Publishing:** Netlify (free tier). The token goes in Integrations; `publish_site` creates the Netlify site on first publish, uploads a zip, and records the live `https://….netlify.app` URL. Republishing updates the same URL.
- **Content calendar:** `draft_post` (text, platforms, optional schedule in owner local time), with list / copy / mark posted / discard on the dashboard. Optional **Ayrshare** integration posts or schedules on approval (`publish_post`, high risk); without it, approving marks the post ready to copy.
- Dashboard: **Studio** tab (sites with preview / publish / copy link, "Ask Mia for a site" form, post calendar).

**Shipped:** `src/studio.js` (sanitizer, sites, zip, Netlify publish with polling, posts, Ayrshare), tools `save_site` / `list_sites` / `publish_site` (high) / `draft_post` / `list_posts` / `publish_post` (high), Mia (designer, Sonnet 5), Netlify + Ayrshare integrations with Test, Studio tab (sandboxed phone/desktop preview, publish, copy link, request changes, Ask-Mia form, calendar). Schema v15. 83 tests, including a syntax check of the dashboard script (a stray apostrophe would otherwise blank the whole page).

## Owner setup
- Netlify: sign up (free) → User settings → Applications → **Personal access tokens** → New → paste in Integrations → Netlify.
- Optional: Ayrshare account, link social profiles there, API key → Integrations → Ayrshare. Free plans are limited; videos need a paid plan.

## Part 2 (later)
- Image generation (needs a provider key), short video, custom domains, post analytics into memory.
