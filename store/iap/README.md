# iOS in-app purchases: swag packs

Everything Codex (or anyone) needs to configure App Store Connect, the server and sandbox testing for the iOS swag
packs. Code: `public/js/shared/iap.js` (catalog), `ios/App/App/StorePlugin.swift` (StoreKit 2), `public/js/store.js` +
`public/js/account.js` (purchase screen), `server/appstore.js` (signature checks) + `server/accounts.js` (crediting).

## What is sold

The iOS app sells **swag packs**: consumable in-app purchases. Each pack adds a fixed amount to the player's **swag
number**, the gold number shown next to their kitty in online games (the player can hide it). The first pack also
activates their **swag account**, which keeps game stats and the cosmetic unlocks earned by playing Multiplayer. Unlocks
are never sold: they're earned by playing, with or without an account. Nothing sold affects gameplay.

## Product catalog (create exactly these in App Store Connect)

App: **RunKittyRun: Run & Skate**, bundle `io.runkittyrun.app`, Apple ID `6820576828`. All four are **Consumable**,
available in all territories, Family Sharing off (consumables can't be shared).

| Product ID (permanent, never reuse) | Type | Reference name | Display name (≤30) | Description (≤45) | Proposed price | What it does (server credit) |
|---|---|---|---|---|---|---|
| `io.runkittyrun.app.swag.small` | Consumable | Swag Pack 0.99 | Swag Pack | Adds 0.99 to your swag number online | USD 0.99 (EUR 0.99) | +0.99 to the swag number (99); activates the swag account |
| `io.runkittyrun.app.swag.medium` | Consumable | Swag Pack 4.99 | Big Swag Pack | Adds 4.99 to your swag number online | USD 4.99 (EUR 4.99) | +4.99 (499); activates the swag account |
| `io.runkittyrun.app.swag.large` | Consumable | Swag Pack 9.99 | Huge Swag Pack | Adds 9.99 to your swag number online | USD 9.99 (EUR 9.99) | +9.99 (999); activates the swag account |
| `io.runkittyrun.app.swag.mega` | Consumable | Swag Pack 19.99 | Legendary Swag Pack | Adds 19.99 to your swag number online | USD 19.99 (EUR 19.99) | +19.99 (1999); activates the swag account |

- Set the base price in the **United States** storefront and let Apple's equalization price the rest. For euro storefronts,
  Apple's equivalent of USD 0.99 may come out at EUR 0.99 or EUR 1.19 (VAT). Use **Edit prices for countries** to pin
  EUR 0.99 / 4.99 / 9.99 / 19.99 if you want them to match the number added. The number added is fixed per product
  (`credit` in `public/js/shared/iap.js`) whatever the storefront price or currency. The app shows Apple's localized price.
- **Review screenshot** (one per product, required): `store/iap/simulator-purchase-screen.png` (2622×1206, taken
  from the real app on an iPhone simulator with StoreKit Testing prices) or `store/iap/iphone-purchase-screen.png`
  (2868×1320, the same screen rendered at the iPhone 6.9" size). The same image works for all four. Also available: `iphone-purchase-done.png`
  (after buying) and `iphone-swag-account.png` (the account with Restore purchases and Delete account).
- **Review notes per product** (optional): "Consumable. Adds the stated amount to the player's swag number shown next to
  their kitty online, and activates their swag account (stats, unlock storage). Cosmetic only, no gameplay effect."
- **Submission:** the first in-app purchases must be submitted **with the app version** (select them in the version's
  "In-App Purchases and Subscriptions" section) and must be "Ready to Submit" first.
- **Prerequisite:** the **Paid Apps Agreement** (Business → Agreements) must be active with banking and tax filled in, or
  products load empty, even in sandbox and TestFlight. Consider enrolling in the App Store Small Business Program (15%).

## Server configuration

Nothing to install: verification uses Node's built-in `crypto`, with Apple Root CA G3 pinned in `server/appstore.js`.

| Setting | Where | Value |
|---|---|---|
| In-app purchases on | default | on. `APPLE_IAP=off` in `/etc/run-kitty-run/accounts.env` turns them off (the app then hides the swag button) |
| Sandbox purchases | default | accepted (TestFlight, sandbox testers, **App Review**), kept on separate sandbox accounts. `APPLE_IAP_SANDBOX=off` refuses them. Don't switch off while a build is in review |
| App Store Server Notifications V2 | App Store Connect → App → App Information → App Store Server Notifications | **Production URL** and **Sandbox URL** both `https://runkittyrun.fun/api/apple/notifications`, **Version 2** |
| Test-only switches | never in production | `APPLE_IAP_TEST_ROOTS` (PEM file of extra trusted roots) and `APPLE_IAP_XCODE=1` (Xcode-signed data) only work when `NODE_ENV` isn't `production` |

The production unit runs with `NODE_ENV=production`. State lives next to the other account state: `accounts.json` (keys
`iap`, `notes`, and `apple` on iOS accounts) plus the append-only `payments.jsonl` ledger, which is replayed at startup.
The App Store Server API (In-App Purchase key) is **not needed**. Optionally create one later to request a test
notification or look up orders.

After deploying, verify the notification endpoint: App Store Connect can't send a test notification without the API,
but a sandbox purchase followed by a sandbox refund (see below) logs `app store notification: REFUND` in
`journalctl -u run-kitty-run`.

## How purchases map to players

- **No sign-in in the app.** The swag account belongs to the **App Store account** that installed the app. The app sends
  Apple's signed app transaction (`AppTransaction`, iOS 16+). The server verifies it and keys the account by its
  `appTransactionId`, which Apple keeps the same for that Apple Account on every device and across reinstalls.
  Production and Sandbox accounts are kept apart.
- **Guests can buy.** Tapping a pack creates the swag account if needed, and the purchase carries that account's
  `appAccountToken` (a random UUID the server issued). The server credits only that account, once per `transactionId`.
- **Reinstall / new device:** found again quietly at launch (no prompt), or with **Restore purchases**.
- **Guest unlock progress** on the device moves onto the swag account once it's active (same as on the web).
- **Web accounts** (Google / Discord, Stripe) stay separate: there's no sign-in in the app, so a web account's swag doesn't
  show in the app and vice versa. Linking them would need Sign in with Apple next to Google/Discord (guideline 4.8), a new
  App ID capability and a regenerated App Store profile. Not done for this release.
- **Account deletion in the app:** Swag account → Delete account (type DELETE, then confirm). It's hidden right away and
  gone after 14 days. Restore purchases within 14 days brings it back.

## Purchase states the app handles

| Case | What the player sees | What happens |
|---|---|---|
| Success | "THANK YOU! +4.99! Your swag number is now …" | Signed transaction → server verifies and credits → app finishes it |
| Cancelled | "No worries, nothing was charged." | Nothing |
| Pending (Ask to Buy, SCA) | "Waiting for approval. Your swag arrives as soon as the purchase is approved." | Arrives later through `Transaction.updates` → credited → "Your swag arrived!" |
| Failed: network / not allowed (Screen Time) / unavailable / other | Its own message | Nothing charged |
| Paid but our server unreachable | "Payment done! Your swag is added as soon as the game reaches its server again" | Stays unfinished in StoreKit; credited at the next launch or Restore |
| Refund | Number goes down | REFUND notification (or the revoked transaction at Restore) takes the credit back once; REFUND_REVERSED gives it back |
| iOS 15, or server switch off | No swag button | |

## Sandbox testing (precise steps)

1. App Store Connect → **Users and Access → Sandbox → Test Accounts → +**: create a tester with an email that isn't an
   Apple Account. Set its country to the storefront you want to test (e.g. United States).
2. Make sure the four products exist (status *Ready to Submit* is enough for sandbox) and the Paid Apps Agreement is
   active. New products can take up to an hour to reach the sandbox.
3. Install a **TestFlight** build (Actions → Mobile apps → Run workflow, tick "Upload iOS build to TestFlight"), or run
   from Xcode on a device. TestFlight purchases are free and use the sandbox.
4. On the iPhone: **Settings → Developer → Sandbox Apple Account** → sign in with the tester. The menu appears after
   the first purchase attempt on iOS 18+; on older iOS, sign in when the purchase sheet asks.
5. In the game: main menu → **SWAG ACCOUNT** → the four packs with sandbox prices → tap **Swag Pack** → confirm.
   Expect "THANK YOU! +0.99…", and the number under your kitty in an online lobby.
6. Cancel: tap a pack, then cancel the sheet → "No worries, nothing was charged."
7. Ask to Buy / pending: Settings → Developer → Sandbox Apple Account → Manage → enable **Ask to Buy** (or Interrupted
   Purchases) → buy → "Waiting for approval". Approve it in the same Manage screen or the system prompt, then return to
   the app → "Your swag arrived!".
8. Restore: delete the app, reinstall from TestFlight, open → the swag button already shows your number. Or open Swag
   account → **Restore purchases** → "Restored! Your swag is back."
9. Refund: Settings → Developer → Sandbox Apple Account → Manage → **Refund** a pack (iOS 18+), or use
   `reportaproblem.apple.com` with the tester. The server logs `app store notification: REFUND` and the number drops.
   Sandbox notifications are sent **once only**: if the server was down, Restore purchases still catches it (revoked).
10. Delete: Swag account → Delete account → type DELETE → DELETE FOREVER → YES. Then Restore purchases → RESTORE MY ACCOUNT.

Local without the App Store: open the project in Xcode and Run. The shared **App** scheme uses
`ios/App/AppTests/Products.storekit` (StoreKit Testing, prices $0.99–$19.99), so the packs show and can be bought without
a network. Purchases still go to the production server, which refuses Xcode-signed data, so they stay unfinished. For an
end-to-end local test, run a dev server with `APPLE_IAP_XCODE=1` and open the app's page with
`?account=http://<your-mac-ip>:8080` (local addresses only).

## Automated tests

- `node scripts/iap-test.mjs` (in `npm test`, CI): 50 server checks with a test certificate chain made by openssl.
  Covers signature, chain, OIDs, bundle, environment, Xcode refusal, link/restore, credit once, replay, tampering,
  unknown product, quantity, appAccountToken owner, sandbox separation, refunds (notification + revoked, duplicates,
  reversal, refund before credit), ONE_TIME_CHARGE backup, ledger replay after a crash, deletion/restore.
- `node scripts/iap-test.mjs --ui` (`PLAYWRIGHT_DIR=… PW_CHANNEL=chrome`): 20 more end-to-end checks of the real purchase
  screen in Chrome, with a stand-in Store plugin that signs like the App Store. Covers prices, cancel, network /
  not-allowed / other failure, success, Ask to Buy approved later, server unreachable then relaunch, reinstall, Restore,
  refund, delete and restore. Renders the screenshots in this folder.
- `ios/App/AppTests/StoreTests.swift` (workflow **iOS StoreKit tests**, simulator, StoreKitTest): the native side against
  `Products.storekit`. Covers localized prices, unknown product, purchase signed with the appAccountToken and left
  unfinished until finish, Ask to Buy approve/decline via `Transaction.updates`, failure, cancel, refund showing as
  revoked, finished consumables in history (iOS 18), app transaction, plugin registration.

## App Review notes (paste into App Review Information → Notes, after the existing paragraph)

> In-app purchases: four consumable "swag packs" (Swag Account button on the main menu). Each pack adds a fixed amount to the player's swag number, a cosmetic gold number shown next to their kitty in online games (it can be hidden), and activates their swag account, which keeps game stats and the cosmetic unlocks earned by playing. Nothing sold affects gameplay; unlocks are earned by playing, never sold. No sign-in is required to buy: the swag account is tied to the App Store account (via the app transaction), so "Restore purchases" in the same screen brings it back after reinstalling or on another device. The account can be deleted in the app (Swag Account → Delete account). To see the number online, open Online → Create lobby after buying. Purchases are verified on our server with Apple's signed transactions; sandbox purchases are accepted.

## Blockers / to do before submitting
- **GitHub Actions is blocked by billing**: "recent account payments have failed or your spending limit needs to be
  increased" (Settings → Billing and plans). Until that's fixed, no workflow runs: not the TestFlight upload, not the
  StoreKit tests, and **not the server deploy on push to `main`**.

- Paid Apps Agreement, banking and tax must be active (Codex / account holder).
- Create the four products exactly as above, with review screenshots. Set up the Server Notifications URLs.
- Deploy the server (merge to `main`) **before** the build goes to review: the app reads `/api/account/config` to show the
  swag button, and verifies purchases at `/api/account/apple/*`.
- Signing is verified: Actions → Mobile apps → Run workflow with **iOS signing check** archives, signs with the App Store
  profile and exports the `.ipa` without uploading (passed on this branch: `get-task-allow` false, associated domains
  incl. `runkittyrun.fun`). The lane now imports the p12 with `security import`, because fastlane's `import_certificate`
  silently imported nothing, and signs with the identity's exact name (the certificate is an "iPhone Distribution" one).
  In-app purchase needs no profile change: it's on by default for every App ID, and this release adds no Sign in with Apple.
