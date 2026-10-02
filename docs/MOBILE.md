# Run Kitty Run — iOS & Android playbook

Everything needed to build, test and ship the store apps. Work top to bottom; sections 3–6 are one-time setup.

## 1. How it works

- **Capacitor** wraps `public/` (copied to `www/` by `npm run build:www`) into native iOS/Android shells. The game files are bundled in the app; nothing is loaded from the web at startup.
- The apps play on the **same server** as the website (`https://80-47-225-25.nip.io`), so web, iOS and Android players share lobbies (cross-play). Solo / local co-op work offline.
- **Protocol gate:** on connect the client sends `{t:'hi', v:PROTOCOL_VERSION}`; the server rejects `v < MIN_PROTOCOL` with an "update the app" screen. Web players always get the newest code, app players don't — an app update takes days (review + users updating), so the server must stay backward compatible (see §9).
- **Deep links:** invite links on either host (`https://80-47-225-25.nip.io/?room=ABCD` or `https://runkittyrun.80-47-225-25.nip.io/?room=ABCD`) open the app if installed (iOS Universal Links via `/.well-known/apple-app-site-association`, Android App Links via `/.well-known/assetlinks.json`), plus the `runkittyrun://join?room=ABCD` scheme.
- **Moderation** (required by both stores for chat; apps only, the web is unfiltered): name/chat filter applied in the app when messages arrive (`public/js/shared/filter.js` via `net.js`), Report and Mute in the chat player menu (`public/js/chat.js`), terms acceptance before first online game (`public/js/terms.js`), reports in `/var/lib/run-kitty-run/reports.jsonl`.
- Native bits: haptics, native share sheet, keep-awake, status bar/splash (`public/js/platform.js`).

## 2. Local development

```bash
npm install
npm run build:www          # public/ -> www/
npm run android:sync       # build:www + cap sync android   (ios:sync for iOS)
npm run android:build      # debug APK -> android/app/build/outputs/apk/debug/
npm run android:open       # open in Android Studio (optional)
npm run ios:open           # open in Xcode
npm run assets             # regenerate icons/splash from resources/
```

Run `npm run android:sync` / `ios:sync` after every change to `public/` — the apps bundle a copy.

**Android emulator** (SDK already at `~/android-sdk`, AVD `kitty`; JDK 21 from Homebrew). Add to `~/.zshrc`:

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export ANDROID_HOME=$HOME/android-sdk
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
```

```bash
emulator -avd kitty &                      # boot the emulator
npx cap run android                        # build, install, launch (picks the running emulator)
adb install -r android/app/build/outputs/apk/debug/app-debug.apk   # or install an APK from CI
```

**iOS Simulator:** install Xcode from the Mac App Store, open it once (accept license, install the iOS platform), then

```bash
sudo xcode-select -s /Applications/Xcode.app
npm run ios:sync && npx cap run ios        # or: npm run ios:open and press ▶ in Xcode
```

No Xcode yet? Download the `ios-simulator-app` artifact from any CI run, unzip, drag `App.app` onto a booted Simulator.

**App against a local server.** The app always talks to production unless the page URL has `?server=`. To test server changes:

- Web: `npm run dev`, then `http://localhost:8080/?server=ws://localhost:8080/ws`.
- App (live reload — the app loads files straight from your Mac and reloads on save; nothing to commit):
  temporarily add to `capacitor.config.json`
  `"server": { "url": "http://<your-LAN-IP>:8080/?server=ws://<your-LAN-IP>:8080/ws", "cleartext": true }`,
  run `npm run dev`, then `npx cap run android` (or `ios`). Remove the block before committing.
  Quicker for client-only changes: `npx cap run android --live-reload --host <your-LAN-IP> --port 8080` with `npm run dev`
  running — the app loads your local files but still plays online on production. (Emulator → Mac is `10.0.2.2`.)

## 3. Developer accounts (one-time)

**Apple Developer Program** — $99/year, <https://developer.apple.com/programs/enroll/>.
- *Individual*: quick (ID check in the Apple Developer app); the store shows **your legal name** as the seller.
- *Organization*: needs a legal entity + free **D-U-N-S number** (can take 1–2 weeks); store shows the company name.

**Google Play Console** — $25 once, <https://play.google.com/console/signup>. Identity verification (government ID; for orgs also D-U-N-S) takes a few days.
- **Personal accounts created after 13 Nov 2023 must run a closed test with ≥ 12 testers opted in for 14 consecutive days** before they can apply for production access. Start this as early as possible (§8).
- Organization accounts are exempt from that rule.

## 4. One-time store setup

**Apple**
1. <https://developer.apple.com/account/resources/identifiers> → **+** → App IDs → App → Explicit bundle ID `io.runkittyrun.app`, description "Run Kitty Run", tick **Associated Domains**. Save.
2. Note your **Team ID** (Membership details, 10 chars).
3. <https://appstoreconnect.apple.com> → Apps → **+ New App**: platform iOS, name `Run Kitty Run`, language English (U.S.), bundle ID `io.runkittyrun.app`, SKU `runkittyrun`, full access.
4. App Privacy, age rating, category, pricing (Free), availability: fill in from `store/answers.md`.

**Google**
1. Play Console → **Create app**: name `Run Kitty Run`, game, free, accept declarations.
2. App content: privacy policy URL `https://80-47-225-25.nip.io/privacy.html`, ads (no), app access (no login), content rating questionnaire, target audience, data safety, government/financial (no) — answers in `store/answers.md`.
3. The **first AAB must be uploaded by hand** (Play's API refuses uploads for a brand-new app): download `android-release-aab` from a signed CI run (§5 secrets set first) and upload it under Testing → Internal testing → Create release. After that, CI can upload.

## 5. GitHub secrets

Repo → Settings → Secrets and variables → Actions → New repository secret (or `gh secret set NAME`).

| Secret | What | How to get it |
|---|---|---|
| `RKR_KEYSTORE_BASE64` | Android upload keystore, base64 | see below |
| `RKR_KEYSTORE_PASSWORD` | keystore password | you choose it |
| `RKR_KEY_ALIAS` | key alias | `upload` (as below) |
| `RKR_KEY_PASSWORD` | key password | you choose it (can equal keystore password) |
| `PLAY_SERVICE_ACCOUNT_JSON` | Play API service account JSON (raw JSON) | see below |
| `ASC_KEY_ID` | App Store Connect API key ID | see below |
| `ASC_ISSUER_ID` | API issuer ID (UUID) | same page as the key |
| `ASC_KEY_P8_BASE64` | the `.p8` key file, base64 | see below |
| `APPLE_TEAM_ID` | 10-char Team ID | developer.apple.com → Membership |

**Android upload keystore** (keep the file and passwords in your password manager — losing them means a key-reset request to Google):

```bash
keytool -genkeypair -v -keystore ~/rkr-upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
gh secret set RKR_KEYSTORE_BASE64 --body "$(base64 -i ~/rkr-upload.jks)"
gh secret set RKR_KEY_ALIAS --body upload
gh secret set RKR_KEYSTORE_PASSWORD     # prompts
gh secret set RKR_KEY_PASSWORD          # prompts
```

This is the *upload* key; Google re-signs releases with its own **app signing key** (Play App Signing, on by default).

**Play service account**
1. <https://console.cloud.google.com> → create a project → APIs & Services → enable **Google Play Android Developer API**.
2. IAM & Admin → Service accounts → Create (no roles needed) → Keys → Add key → JSON → download.
3. Play Console → **Users and permissions** → Invite new users → the service account's email → App permissions: Run Kitty Run → *Release to production, exclude devices, and use Play App Signing*, *Release apps to testing tracks*, *Manage testing tracks*, *Manage store presence*. Invite. (Can take up to a day to start working.)
4. `gh secret set PLAY_SERVICE_ACCOUNT_JSON < ~/Downloads/<file>.json`, then delete the download.

**App Store Connect API key**
1. App Store Connect → **Users and Access → Integrations → App Store Connect API → Team Keys → +**. Name `github-ci`, access **Admin** (CI uses cloud-managed signing, which needs Admin to create the distribution certificate; App Manager is enough for metadata only).
2. Download `AuthKey_XXXXXXXXXX.p8` (only downloadable once). Note the **Key ID** and the **Issuer ID** shown above the list.
3. ```bash
   gh secret set ASC_KEY_ID --body XXXXXXXXXX
   gh secret set ASC_ISSUER_ID --body <issuer-uuid>
   gh secret set ASC_KEY_P8_BASE64 --body "$(base64 -i ~/Downloads/AuthKey_XXXXXXXXXX.p8)"
   gh secret set APPLE_TEAM_ID --body <TEAMID>
   ```

**Server env for deep links** (after the first Play upload / once you have a Team ID). On the server:

```bash
sudo systemctl edit run-kitty-run
#   [Service]
#   Environment=APPLE_TEAM_ID=<TEAMID>
#   Environment=ANDROID_CERT_SHA256=<app-signing SHA-256>,<upload-key SHA-256>
sudo systemctl restart run-kitty-run
curl -s https://80-47-225-25.nip.io/.well-known/apple-app-site-association
curl -s https://80-47-225-25.nip.io/.well-known/assetlinks.json
```

- App-signing SHA-256: Play Console → Test and release → App integrity → App signing → *App signing key certificate*. Include the upload key one too (`keytool -list -v -keystore ~/rkr-upload.jks -alias upload`) so sideloaded CI builds verify as well.
- The drop-in (`/etc/systemd/system/run-kitty-run.service.d/override.conf`) survives deploys (`deploy.sh` never reinstalls the unit). `deploy/run-kitty-run.service` has the same lines commented out, for fresh installs via `setup.sh`.
- Apple caches the association file via its CDN; changes can take up to a day to reach devices. Reinstall the app to re-fetch.

## 6. Store listings

Listing text, screenshots and graphics live in `fastlane/metadata/` (iOS: `fastlane/metadata/<locale>`, Android: `fastlane/metadata/android/<locale>`) and `fastlane/screenshots/`. Upload them without a binary:

```bash
bundle install                                  # once (Ruby + fastlane)
export ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_PATH=~/keys/AuthKey_….p8
bundle exec fastlane ios metadata               # text + screenshots, no review submission
export SUPPLY_JSON_KEY=~/keys/play.json         # or PLAY_SERVICE_ACCOUNT_JSON="$(cat …)"
bundle exec fastlane android metadata           # text + icon + feature graphic + screenshots
```

Required screenshots: iPhone 6.9" **and iPad 13"** (the app supports iPad), Android phone (2–8) + 1024×500 feature graphic.

## 7. CI (`.github/workflows/mobile.yml`)

Every push to `main`/`mobile-apps` touching the app (and every PR) runs tests, then builds:
- **android**: debug APK (`android-debug-apk` artifact, sideload with `adb install`) + release AAB (`android-release-aab`, signed if the keystore secrets exist).
- **ios**: Simulator build (`ios-simulator-app` artifact) — proves the project compiles with the newest Xcode.

Store uploads only from Actions → **Mobile apps → Run workflow**:
- `release_ios` → archive with cloud-managed signing, upload to **TestFlight** (`fastlane ios beta`).
- `release_android` → upload the AAB to `play_track` (internal / alpha = closed testing / beta = open / production) with `play_status` (keep **draft** until the app has been published once, then **completed**).

Build numbers (iOS build, Android `versionCode`) are the workflow run number, so they always increase. Don't upload builds from your own machine or they'll collide.

## 8. Releasing a version

1. Bump the version (marketing version only; build numbers come from CI):
   `node scripts/bump-version.mjs 1.1.0` (or `patch` / `minor`) → updates `package.json`, `public/js/platform.js` `APP_VERSION`, `android/app/build.gradle` `versionName`, iOS `MARKETING_VERSION`. Add a line to `public/js/patchnotes.js`. Commit, push.
2. Actions → Mobile apps → Run workflow on the branch, tick `release_ios` and/or `release_android`.
3. **iOS**: build appears in App Store Connect → TestFlight after processing (5–30 min). Internal testers (your team, up to 100) can install at once; external testers need a quick Beta App Review. When happy: App Store tab → the version → *Build* → select it → fill "What's New" → **Add for Review** → Submit. Review usually takes 1–2 days.
4. **Android**: first time: internal track (instant, up to 100 testers by email) → **closed testing** with ≥ 12 testers opted in for 14 days (personal accounts) → Dashboard → *Apply for production* → production rollout (review: hours to days). Later releases: run the workflow with `play_track: production`, `play_status: completed` — or promote a tested internal build in the console.
5. Production "Update" button in the app: once the iOS app is live, put its numeric App Store id into `STORE_URLS.ios` in `public/js/platform.js`.

Only `public/`-only changes? The website updates on deploy as usual; the apps keep their bundled copy until you ship a new app version. Ship app updates for anything player-visible.

## 9. Server compatibility rules

- `PROTOCOL_VERSION` (`public/js/shared/config.js`): bump when the wire messages or the shared sim change so an old client would desync or break (new required message fields, changed sim rules/constants, changed snapshot format). Cosmetic/client-only changes: no bump.
- `MIN_PROTOCOL` (`server/index.js`): the oldest client the server still accepts. Raise it only once the store versions that speak the new protocol are **live and have been out for a while** — raising it shows every older app "update to keep playing online".
- In practice: make the server accept both old and new clients (branch on `client.v`) for at least the review + rollout window (≈ 1–2 weeks), ship the app update, then raise `MIN_PROTOCOL` and delete the old branch.
- Cross-play means a lobby can mix versions: the server must not send new-protocol-only messages to old clients.
- Server deploys (push to `main`) go live instantly for everyone — never ship a server change that breaks the protocol the current store apps speak.

## 10. App Review notes & gotchas

**Paste into App Store Connect → App Review Information → Notes** (and Play → App access: "no special access"):

> Run Kitty Run is a 3D runner. No account or login is needed. Solo and local play work offline from the title screen. Online play: tap Online → Create lobby; you can start a run alone in your lobby (other players join with the 4-letter code or an invite link, cross-platform with the web version at https://80-47-225-25.nip.io). Lobby chat is moderated: profanity filter on names and messages, and every player can be reported or blocked from the chat player menu (tap a name). Players accept the Terms (zero tolerance for abusive content) before going online. Reports are reviewed by the developer within 24 hours. Support: https://80-47-225-25.nip.io/support.html

- **4.2 Minimum functionality** (web wrappers get rejected): the game is bundled, starts offline, and uses native haptics, share sheet, keep-awake and deep links. Don't describe it as "the website in an app".
- **1.2 User-generated content**: needs filter + report + block + terms + a way to contact you — all present (chat menu, `terms.html`, `support.html`). Actually read the reports (`scripts/reports.sh`) and act within 24 h.
- **Export compliance**: `ITSAppUsesNonExemptEncryption = false` is in `Info.plist` (only HTTPS/WSS), so no questions per build.
- **Privacy manifest**: `ios/App/App/PrivacyInfo.xcprivacy` is bundled; privacy label = data not collected / not linked (see `store/answers.md`). Feedback/reports store the player name + text only.
- **iPad**: the app is universal, so iPad screenshots are mandatory and reviewers test on iPad.
- **Xcode version**: Apple only accepts builds from the current Xcode/SDK; CI uses `latest-stable` on the newest macOS runner. If uploads get rejected for SDK version, bump `runs-on` in `mobile.yml`.
- **Google**: target the latest API level (`targetSdkVersion` in `android/variables.gradle`, 36 now) — Play enforces this each August. Data safety form must match `store/answers.md`.
- **Domain**: the apps talk to `80-47-225-25.nip.io` (`PROD_ORIGIN`); deep links accept it and `runkittyrun.80-47-225-25.nip.io`, so both must keep serving the game and the `/.well-known` files. If the server ever moves, update the entitlement (`ios/App/App/App.entitlements`), the Android intent filter, `PROD_ORIGIN` in `platform.js` — and old apps will point at the old host, so keep it alive. A real domain is worth buying before launch.

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| App shows old game code | `npm run android:sync` / `ios:sync` (rebuilds `www/` and copies it) |
| `SDK location not found` | `export ANDROID_HOME=$HOME/android-sdk` or create `android/local.properties` with `sdk.dir=/Users/<you>/android-sdk` |
| `Unable to locate a Java Runtime` / Gradle wants JDK 21 | `export JAVA_HOME=/opt/homebrew/opt/openjdk@21` |
| CI release AAB "unsigned" warning | the four `RKR_KEY*` secrets are missing or misnamed |
| Play upload: "Only releases with status draft may be created on draft app" | run with `play_status: draft` until the app has been published once |
| Play upload: "Package not found" / 403 | upload the first AAB manually (§4); service account not invited yet or invite < 24 h old |
| Play: "Version code N has already been used" | CI run numbers restarted (workflow renamed?) — bump with `node scripts/bump-version.mjs <ver> --build <higher>` and add an offset in `mobile.yml` |
| iOS archive: "No Accounts" / "No profiles for io.runkittyrun.app" | API key role must be **Admin**; App ID must exist with Associated Domains (§4) |
| iOS upload: "bundle version must be higher" | that run number was already uploaded; just run the workflow again |
| "A new version is out" overlay in the app | server `MIN_PROTOCOL` is above the app's `PROTOCOL_VERSION` — ship the update or lower it |
| Invite link opens the browser, not the app | check the `/.well-known` URLs return your real Team ID / SHA-256 (§5); reinstall the app; on Android `adb shell pm verify-app-links --re-verify io.runkittyrun.app` |
| Online doesn't connect in the app but web works | CORS / origin: server must allow `capacitor://localhost` and `https://localhost`; check `journalctl -u run-kitty-run` |
