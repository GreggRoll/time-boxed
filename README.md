<p align="center">
  <img src="TimeBoxed/Assets.xcassets/AppIcon.appiconset/Minimalist%20timeBoxed%20app%20icon.png" alt="Time Boxed app icon" width="120" />
</p>

<h1 align="center">Time Boxed</h1>
<p align="center"><strong>Give your priorities a place in your day.</strong><br />A thoughtful daily planner for iPhone and iPad, built with SwiftUI.</p>
<p align="center">iOS 17+ · iPhone & iPad · SwiftUI · StoreKit 2</p>

Time Boxed brings your priorities, loose thoughts, and schedule into one calm workspace. Capture what matters, make room for it on your timeline, and return to your plans as the day unfolds.

This repository contains the native iOS app and the original Next.js web prototype. Native iOS is the focus of current development; the features below describe the iOS app unless noted otherwise.

## A daily planner that fits your day

- **Priorities up front.** Choose between one and six priorities to keep the important things visible.
- **A home for loose thoughts.** Use the Brain Dump to capture notes, ideas, and tasks before deciding where they belong.
- **Flexible time boxing.** Set your planning hours and choose 30- or 60-minute slots.
- **Room for deep work.** Merge adjacent blocks into longer sessions, unmerge them, or clear a block when plans change.
- **Plan directly on the timeline.** Edit blocks inline, move between entries with keyboard controls, and see the current time highlighted in today's schedule.
- **Automatic saving.** Plans are saved locally on your device, so daily planning works offline and needs no account.
- **Your preferred appearance.** Choose light, dark, or system appearance, with layouts for iPhone and iPad.
- **Settings that respect existing plans.** Filled days retain their original block interval when you change the default.

## More room with Time Boxed Pro

Today's planner stays free. Pro adds ways to revisit your plans and bring them into the Apple apps you already use.

| Feature | Free | Pro |
| --- | :---: | :---: |
| Today's priorities, Brain Dump, and time boxes | ✓ | ✓ |
| Custom planning hours and block lengths | ✓ | ✓ |
| Merge and unmerge blocks | ✓ | ✓ |
| Local autosave and appearance settings | ✓ | ✓ |
| Saved-day calendar and history access | | ✓ |
| Export individual blocks to Apple Calendar | | ✓ |
| Export individual blocks to Apple Reminders | | ✓ |

Calendar exports preserve a block's start and end times. Reminders use its start time as the due date. Choose your default export destination in settings; access is requested when you export.

Pro supports a monthly subscription or a one-time lifetime purchase, with localized pricing supplied by StoreKit. Both unlock the same features. Purchase restoration and subscription management are built in, and saved plans remain on your device if Pro access ends.

> Pro purchasing is implemented, with a bundled StoreKit configuration for development. App Store availability depends on release and product approval; this README is not a release announcement.

## In the works

The current development workspace also includes:

- **A guided first run** that introduces the planner and helps you choose planning hours, block length, and appearance.
- **Export All** to send every filled block in a day to Calendar or Reminders with Pro.
- **Layout and keyboard refinements** to make editing and scrolling through a plan more comfortable.

These changes are in progress and may not yet be present in the committed app source or a distributed build. Exports currently create new entries each time; duplicate prevention is not implemented.

## Build and explore

### Native iOS app

You'll need macOS, Xcode with an iOS 17+ SDK, and an iPhone or iPad simulator or device.

```sh
git clone https://github.com/GreggRoll/time-boxed.git
cd time-boxed
open TimeBoxed.xcodeproj
```

Select the **TimeBoxed** scheme, choose a simulator, and run. For a physical device, configure your signing team in Xcode.

Run the test suite with **Product → Test**. Tests cover persistence, block editing and merging, schedule settings, history access, and StoreKit purchase and entitlement behavior.

For interactive Pro testing, select `TimeBoxedTests/Pro.storekit` under **Edit Scheme → Run → Options → StoreKit Configuration**. Switch it back to **None** for App Store sandbox or TestFlight testing. See the [Pro implementation and testing notes](docs/pro-purchases.md) for setup details and known simulator caveats.

### Original web prototype

The web implementation uses **Next.js, React, TypeScript, Tailwind CSS, and Firebase**. It includes priorities, a Brain Dump, a configurable schedule, Google sign-in, and Firestore-backed day storage. Its data storage is separate from the native app.

To explore it, install Node.js and npm, configure your Firebase project in `.env.local`, and enable Google authentication and Firestore with appropriate access rules:

```dotenv
NEXT_PUBLIC_FIREBASE_API_KEY=your-api-key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-auth-domain
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project-id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your-storage-bucket
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your-sender-id
NEXT_PUBLIC_FIREBASE_APP_ID=your-app-id
```

```sh
npm ci
npm run dev
```

Open [localhost:9002](http://localhost:9002). Additional scripts include `npm run build`, `npm run lint`, and `npm run typecheck`.

## Under the hood

The native app uses **SwiftUI and Observation** for its interface and state, **local JSON files** for day storage, **UserDefaults** for preferences, **EventKit** for exports, and **StoreKit 2** for Pro purchases and verified entitlements.

| Path | What's inside |
| --- | --- |
| [`TimeBoxed/App`](TimeBoxed/App) | App entry point and lifecycle |
| [`TimeBoxed/UI`](TimeBoxed/UI) | Planner, sidebar, saved-day calendar, and Pro screens |
| [`TimeBoxed/Models`](TimeBoxed/Models) | Day sheets, time blocks, and shared types |
| [`TimeBoxed/Persistence`](TimeBoxed/Persistence) | Local day storage, autosave, and settings |
| [`TimeBoxed/Services`](TimeBoxed/Services) | Calendar/Reminders exports and Pro access |
| [`TimeBoxedTests`](TimeBoxedTests) | XCTest suite and StoreKit test catalog |
| [`src`](src) | Original Next.js web prototype |
| [`docs`](docs) | Privacy policy site and development notes |

## Project notes

- [Privacy policy source](docs/index.html)
- [Pro purchases, configuration, and testing](docs/pro-purchases.md)
- [App review subscription-link notes](docs/app-review-subscription-links.md)

Possible next steps include reusable day templates, weekly reviews, searchable history, and iCloud sync. These are ideas for future development, not current features or release commitments.
