# Search and listings

Why: "run kitty run" is crowded (8+ itch.io games, RAWG, App Store titles). Our pages are fine on-page; what's missing is
Google/Bing knowing the site and other sites linking to it. Each listing below is a backlink and a page that can rank by itself.
Every listing links to `https://runkittyrun.fun/` and uses the name **Run Kitty Run** first.

## 1. Search engines (operator, ~20 min, once)

- **Google Search Console**: add a *Domain* property for `runkittyrun.fun`, verify with the DNS TXT record, submit
  `https://runkittyrun.fun/sitemap.xml`, then URL Inspection → Request indexing for `/`, `/about`, `/how-to-play`,
  `/warcraft-3-run-kitty-run`, `/patch-notes`.
- **Bing Webmaster Tools**: "Import from Google Search Console" (one click once Google is verified). Bing feeds ChatGPT search
  and Copilot.
- **IndexNow** is automatic: `deploy/deploy.sh` runs `scripts/indexnow.sh` for changed pages after each healthy deploy
  (key file `public/d7a1bfb11d19eda8d125653160d88983.txt`). Run `scripts/indexnow.sh` by hand once after the first deploy.

## 2. itch.io (highest value: itch already owns the results page)

- Kind: HTML5 is better than a link-out if the game runs in an iframe; otherwise a "Play at runkittyrun.fun" page.
- Title: `Run Kitty Run` · URL slug: `run-kitty-run` (or `run-kitty-run-online` if taken)
- Short description: `Free online co-op for 1 to 32 kitties. Dodge the wolves, revive your friends, beat the labyrinth together.`
- Genre: Action · Tags: `co-op`, `multiplayer`, `browser`, `cats`, `warcraft-3`, `party-game`, `local-co-op`, `three-js`
- Screenshots: `public/img/run-kitty-run-*.webp` (export to PNG), cover from `public/og-image.jpg` (630×500 crop).
- Body:

  > **Run Kitty Run** is a free online co-op game for 1 to 32 players, inspired by the classic Warcraft 3 custom map.
  > You're a kitty in a square-spiral labyrinth full of wolves. Reach the heart of the labyrinth, don't touch the wolves,
  > and never leave a kitty behind: run over a fallen friend's circle to bring them back.
  >
  > - Online lobbies up to 32 players, solo, and two-player local co-op
  > - Run on foot by day, skate the ice by night, eight levels through the seasons
  > - Works on computers, phones and tablets, cross-play in the same lobby
  > - No download, no account, no ads
  >
  > **Play now: https://runkittyrun.fun**

## 3. Portals and game databases

| Where | What to do | Notes |
|---|---|---|
| CrazyGames | Developer portal submission | Wants their SDK for full listing; basic launch first |
| Newgrounds | Games portal, HTML5 or link | Tag `multiplayer`, `cats` |
| Poki | poki.com/developers form | Curated; long shot |
| RAWG | Add game (account) | There's already a *different* "Run Kitty Run" (2020, PC) there: add ours as its own entry, name "Run Kitty Run (2026)" |
| IGDB | Contribute → add game | Twitch/Google use IGDB data |
| MobyGames | Add game | Slow review, permanent link |
| html5games / iogames.space / iogames.fun lists | Submit form | Long tail |

## 4. Warcraft 3 players (the people actually searching the name)

- **Hive Workshop** forum, *Off-topic / Arena* or the custom-map section: a post "Run Kitty Run, now playable in the browser
  with up to 32 players" with 2–3 screenshots and a short gif. Credit the original map, say it's an independent tribute.
- **Reddit** (one post each, operator's account): r/WC3, r/WebGames, r/iogames, r/playmygame, r/threejs (dev angle).
  Title idea for r/WC3: `I remade Run Kitty Run as a free browser game, 32 players per lobby`.
- **YouTube**: a 1–3 min gameplay video titled `Run Kitty Run - free online co-op browser game (Warcraft 3 map remake)`,
  link in the first line of the description. AI search tools cite Reddit and YouTube heavily.

## 5. When the apps go live

Add the App Store and Google Play URLs to `sameAs` on the VideoGame and Organization entries in `public/index.html`, and
link both from `/about`. (Both store URLs returned 404 on 2026-10-18, so they're not in yet.)
