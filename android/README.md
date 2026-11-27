# Pangmote for Android

A phone controls a PC (started 2026-11-26). The app is a thin shell around the same loader and client page that
browsers and the desktop client app run, in the system's WebView. A PC never controls the phone (the user's decision:
Android asks the person at the phone to allow every screen capture, ends it when the phone locks, and lets other apps
inject input only through an accessibility service).

## What is in it

- `MainActivity`: two WebViews, both served from an https origin of the app's own
  (`https://appassets.androidplatform.net/web/...`, answered from the assets, never fetched): a secure context for WebRTC
  and WebCrypto, with storage that stays.
  - The list of PCs (`assets/web/home.html`, bridge `window.mrApp`): names and what the PCs said they are; a tap opens
    one. "QR로 PC 추가" opens the scanner, "접속 키로 접속" the loader with an empty field (the key is typed each time,
    never kept).
  - A session: the loader (`pangmote-client.html`, copied into the assets at build time) with `window.mrShell` put in
    first (`SHIM`, made on that session's `window.mrAndroid`): the calls of the desktop client app's bridge that make
    sense here, for that one PC only. The page comes from the host, so what a phone can do is updated with the host.
- Adding a PC: the host window's card "휴대폰 추가" shows `https://giukim.github.io/p#1.<one-time code>`. `ScanActivity`
  (Camera2 and ZXing's QR reader; the camera is asked for when it first opens) reads it, or the phone's camera opens the
  link in the app (App Links, `giukim.github.io/.well-known/assetlinks.json`). The loader gets the code
  (`#k=<code>&auto`), the page asks the host for a device token on it (`mrShell.qrPairing`, `deviceHello`), and the token
  the host gives over the session's own connection is kept (`devicePaired`, `deviceVerified`). From then on the PC opens
  with the token alone (`bootDevice`). Only a session a QR code started can store a token.
- `HostStore`: the list (`hosts.json` in the app's storage); a token's secret only encrypted with a key of the Android
  Keystore (AES-256-GCM). No backup, no transfer to another phone (`res/xml/data_extraction_rules.xml`): there it would not
  decrypt anyway, and the PC is added again with its QR code.
- The whole screen is the picture (the system bars hidden), the screen stays on, turning or folding the phone keeps the
  session, the keyboard's height shrinks the page (which keeps the picture's size and moves the text caret above it), back
  asks before it ends a session. Texts in 12 languages (`res/values-*`).

One library: ZXing's core (Apache-2.0, `assets/web/licenses.html` has its licence). No AndroidX; AGP 9's built-in Kotlin
is off (`gradle.properties`).

## Building

Java 21, the Android SDK (`ANDROID_HOME`; platform 36 and its build tools are fetched by the build when missing and
their licences accepted) and Gradle 9.9 (not the wrapper: nothing binary is committed).

```
cd android
gradle assembleDebug lintDebug   # app/build/outputs/apk/debug/app-debug.apk, signed with the machine's debug key
gradle bundleRelease             # the .aab Google Play takes (unsigned: the upload key is the user's)
```

CI (`.github/workflows/ci.yml`, job `android`) builds both and lints on every push, and keeps the test APK for two weeks.
App Links verify only for an APK signed with a certificate `assetlinks.json` names (the Linux build PC's debug key for
now, Google Play's app signing key later); Android checks at install time.

## Trying it on a phone

Install the test APK: allow installing apps from the file manager or messenger it comes through; Samsung phones block
that while "Auto Blocker" is on. Play Protect may warn about an unknown developer. The host must be 0.12.0 or later for
the QR code and the phone features of the page.

## Google Play

`applicationId` `kr.pangmote.app` (permanent), target API 36 (Play's rule from 2026-08-31). The user's personal
developer account needs a closed test with 12 testers for 14 days before production. Registering, the upload key and the
Play Console forms are the user's steps; `play/` has what they need (2026-11-27): `play/README.md` (the steps, in Korean,
with the answers for Play Console's forms: data safety, content rating, app access for the reviewers), `play/listing.md`
(the store texts, ko and en), `play/art/` (icon, feature graphics, a screenshot of the list of PCs; `play/art.js` draws
them from the app's own page and frames screenshots taken on a phone to Play's sizes), `play/upload-key.ps1` and
`play/sign-bundle.ps1` (run by the user: the upload key stays at `%USERPROFILE%\.pangmote-release\play-upload.jks`, and
nobody else reads it). CI keeps the unsigned bundle 30 days (artifact `pangmote-android-release-unsigned`).

The manifest opts the app out of the system WebView's usage figures and its Safe Browsing lookups
(`MetricsOptOut`, `EnableSafeBrowsing`): the WebViews load only the app's own pages, and `PRIVACY.md` names every
connection the app makes.
