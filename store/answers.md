# Store questionnaires: suggested answers

Based on what the game actually does (see `public/privacy.html`): no accounts, no ads, no analytics/tracking SDKs, no
in-app purchases. Online play relays display names + lobby chat; reports and feedback are stored on our server.
Re-check these if any SDK, account system or purchase is added.

## App Store Connect: App Privacy ("nutrition label")

**Do you or your third-party partners collect data from this app?** Yes. Apple counts data sent off the device and kept
longer than needed to service the request in real time, and reports + feedback are stored.

| Data type | Collected? | Linked to identity | Tracking | Purpose |
|---|---|---|---|---|
| User Content → **Other User Content** (feedback text; chat lines attached to a report) | Yes | No | No | App Functionality (moderation), Product Personalization: no |
| User Content → Customer Support | Optional: only if feedback counts as support. Same answers as above | No | No | App Functionality |
| Identifiers (User ID / Device ID) | No (no accounts; the per-connection player id is not stored) | | | |
| Contact Info, Location, Health, Financial, Contacts, Browsing/Search History, Purchases | No | | | |
| Usage Data, Diagnostics | No (no analytics or crash SDK) | | | |

- Display name: chosen freely, never linked to a real identity, only stored inside a report. It is covered by "Other User Content".
- IP addresses in short-lived server logs and reports are used for security/anti-spam. Apple doesn't make you declare
  data used only for security/fraud prevention when it isn't linked or used for tracking. If you want to be conservative,
  add nothing more: IP is not one of Apple's data types.
- **Tracking: No.** No App Tracking Transparency prompt is needed.
- Privacy policy URL: https://80-47-225-25.nip.io/privacy.html

## App Store: Age rating questionnaire

| Question | Answer |
|---|---|
| Cartoon or Fantasy Violence | **Infrequent/Mild**: cartoon wolves "catch" a kitty, which turns into a ghost. No blood or injury |
| Realistic Violence, Prolonged Graphic or Sadistic Violence | None |
| Profanity or Crude Humor | None (chat is filtered, but see user-generated content) |
| Mature/Suggestive Themes, Sexual Content or Nudity | None |
| Horror/Fear Themes | None (wolves are cartoony; at most "Infrequent/Mild" if you want to be cautious) |
| Alcohol, Tobacco, Drugs | None |
| Medical/Treatment Information | None |
| Simulated Gambling, Contests, Loot boxes | None |
| Unrestricted Web Access | **No** (only our own support/privacy/terms pages and the game server) |
| User-Generated Content / messaging between users | **Yes**: online lobby chat and display names |
| Parental controls / age assurance | No |

**Effect:** Apple's newer questionnaire raises the rating of apps where users can chat with strangers (in-app
communication/UGC). Expect **12+** or **13+** with the chat answer instead of 4+/9+ for the game content alone. That is fine
and honest. Do not answer "No" to UGC: App Review will see the chat. Guideline 1.2 is satisfied by: profanity filter on chat
+ names, report button, block button, the first-time Terms/zero-tolerance notice, and a contact address in support.html.
Put that list in the **App Review notes**, plus how to test online play (open Multiplayer, create a lobby; a second device or
the web version at https://80-47-225-25.nip.io can join with the lobby code).

## Google Play: Data safety form

- **Does your app collect or share any of the required user data types?** Yes (collected; not shared).
- **Is all of the user data collected by your app encrypted in transit?** Yes (HTTPS / WSS).
- **Do you provide a way for users to request that their data is deleted?** Yes: by email (see privacy policy; no accounts).
- Data types:
  - **Messages → Other in-app messages** (chat lines attached to reports): Collected, not shared, **processed ephemerally: No**
    (kept when reported), **required: No** (chat is optional), purposes: **App functionality** and **Fraud prevention, security, and compliance**.
  - **App activity → Other user-generated content** (feedback text, display name): Collected, not shared, optional,
    purposes: **App functionality**, **Analytics: No**, **Developer communications: No**.
  - **App info and performance → Diagnostics**: Optional, only if you count the feedback's user agent; purpose App functionality. Otherwise No.
  - Location, Personal info (name, email, user IDs), Financial, Health, Photos, Audio, Files, Calendar, Contacts, Web history,
    Device or other IDs: **Not collected**.
- **Sharing:** none. Transfers to our own server provider are "service provider" processing, not sharing.
- Ads: **No, my app does not contain ads.**

## Google Play: Content rating (IARC questionnaire)

- Category: **Game**.
- Violence: **Yes**, cartoon/fantasy characters. Violence is not realistic, no blood, no gore, characters are not humans.
  Expected result: PEGI 7 / ESRB Everyone (E) or E10+ for "Mild Fantasy Violence".
- Fear: optional "Yes, mildly scary" for the wolves. Answer No unless you find them scary.
- Sexuality, Language, Controlled substances, Crude humour, Gambling: **No**.
- **Users can interact / exchange content: Yes** (chat with other players online). IARC adds the interactive element
  "Users Interact". This doesn't change the age rating.
- Shares user location: **No**. Digital purchases: **No**. Unrestricted internet: **No**.

## Google Play: Target audience and content

- **Recommended target age groups: 13–15, 16–17, 18+.**
- Why not under 13: the open chat with strangers would pull the app into the Families Policy (stricter rules for UGC,
  and teacher-approved/"Designed for Families" requirements). The game itself is kid-friendly, so a later version could
  add a "chat off by default / under-13" mode and then add younger groups.
- "Could your store listing unintentionally appeal to children?" Answer honestly: **Yes**, it is a cartoon cat game. Play then
  asks you to confirm the app follows the Families ad/data rules for incidental child users. It does (no ads, no
  tracking, filtered chat, block/report).
- **Ads: No. In-app purchases: No. News app: No. Government app: No. Health: No. COVID: No.**
- **App access:** all features are available without login. No credentials are needed for review.

## App Store: other fields

- Primary category **Games**, subcategories **Action** and **Family** (fastlane: `GAMES`, `GAMES_ACTION`, `GAMES_FAMILY`).
- Pricing: Free. Made for Kids: **No** (because of chat).
- Export compliance: uses only standard HTTPS/WSS (exempt). Set `ITSAppUsesNonExemptEncryption = NO` in Info.plist.
- Sign-in required: No. Contact: maximilian.rehn@gmail.com.
