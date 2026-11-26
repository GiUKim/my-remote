# Pangmote for Android

A phone controls a PC (started 2026-11-26). The app is a thin shell around the same loader and client page that
browsers and the desktop client app run, in the system's WebView:

- `pangmote-client.html` (the loader, at the repository's root) is copied into the app's assets at build time and
  served from an https origin of the app's own (`https://appassets.androidplatform.net/web/loader.html`, answered by
  `MainActivity` itself, never fetched): a secure context for WebRTC and WebCrypto, with storage that stays.
- The loader fetches the client page from the host, as everywhere else: what a phone can do comes with the host and is
  updated with it (the trackpad, the keyboard that comes up by itself: `client.template.html`).
- The whole screen is the picture (the system bars hidden), the screen stays on, turning or folding the phone keeps
  the session, the keyboard's height shrinks the page (which keeps the picture's size and moves the text caret above
  the keyboard), back asks before it closes.
- `window.mrAndroid` (the page may ask): `showKeyboard()`, `version()`. Nothing else yet: the list of PCs, device
  tokens and the other powers of the desktop client app come with the page signature check (client/pagecheck.js).

Not in this app: a PC controlling the phone (the user's decision, 2026-11-26: Android asks the person at the phone to
allow every screen capture, ends it when the phone locks, and lets other apps inject input only through an
accessibility service).

## Building

Java 21, the Android SDK (`ANDROID_HOME`; platform 36 and its build tools are fetched by the build when missing and
their licences accepted) and Gradle 9.9 (not the wrapper: nothing binary is committed). No library is used, not even
AndroidX, and AGP 9's built-in Kotlin is off (`gradle.properties`): the app is a few Java classes.

```
cd android
gradle assembleDebug     # app/build/outputs/apk/debug/app-debug.apk, signed with the build machine's debug key
gradle bundleRelease     # the .aab Google Play takes (unsigned: the upload key is the user's)
```

CI (`.github/workflows/ci.yml`, job `android`) builds both on every push and keeps the test APK for two weeks.

## Trying it on a phone

Install the test APK (from CI's artifact or a build): allow installing apps from the file manager or browser it comes
through; Samsung phones block that while "Auto Blocker" is on. Play Protect may warn about an unknown developer. The
host must serve a page with the phone features (0.11.0 or later) for the trackpad and the keyboard.

## Google Play

`applicationId` `kr.pangmote.app` (permanent), target API 36 (Play's rule from 2026-08-31). The user's personal
developer account needs a closed test with 12 testers for 14 days before production. Registering, the upload key and
the Play Console forms are the user's steps.
