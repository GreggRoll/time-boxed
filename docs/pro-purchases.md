# Time Boxed Pro

Both the monthly subscription and lifetime purchase unlock saved-day history and individual time-box exports to Apple Calendar and Reminders. Today's planner stays free. Saved days remain in local storage when access ends.

## App Store Connect setup

Existing app: [6762071236 — Time Boxed](https://appstoreconnect.apple.com/apps/6762071236).

Draft products and English localizations were created under that app on September 15, 2026. Their identifiers match `ProStore` and the StoreKit test configuration.

| Product ID | App Store Connect ID | Type | US price status |
| --- | --- | --- | --- |
| `com.GregAdams.TimeBoxed.pro.monthly` | `6812531377` | Auto-renewable, one month | $0.99/month starting price saved and verified |
| `com.GregAdams.TimeBoxed.pro.lifetime` | `6812531093` | Non-consumable | $9.99 starting price saved and verified |

Subscription group: **Time Boxed Pro**, ID `22388123`.

Both US starting prices are saved and verified. The monthly subscription uses a one-month period with payment at the beginning of each period. Its initial price was saved through `PATCH /v1/subscriptions/{id}` with an included price record; the standalone subscription-price creation endpoint rejected initial-price requests. No browser sign-in is needed for this completed pricing step.

Both products remain in `MISSING_METADATA`; neither has been submitted for review. Finish availability/territory choices and review screenshots, confirm account agreements and tax/banking status, and submit them with the app when ready. Live localized prices come from StoreKit.

The public privacy policy is published at https://greggroll.github.io/TimeBox/ (verified September 16, 2026). App Store Connect privacy metadata still needs to be confirmed separately.

`TimeBoxed/Info.plist` supplies `ProPrivacyPolicyURL` in both Debug and Release, enabling both purchase buttons. Both configurations use this file alongside Xcode's generated entries; a custom `INFOPLIST_KEY_` build setting alone did not include the key in the built app. A regression test checks the generated app bundle contains this URL. If this key is removed, the Pro page disables new purchases; restore purchases remains available. The page uses Apple's standard EULA. Also provide the policy and terms links in App Store metadata. See [Apple's subscription guidance](https://developer.apple.com/app-store/subscriptions/).

The product drafts, localizations, and both US prices are saved in App Store Connect. No app or product review submission, build upload, or release was performed.

## Implementation

- `ProStore` verifies StoreKit 2 current entitlements at launch, when returning to the foreground, while active, after purchases/restores, and when transactions change. Refunds and expired subscriptions lose access. StoreKit billing grace period entitlements retain access.
- A disabled, accessibility-hidden calendar sits beneath the blurred history overlay. The unlock button, sidebar Pro entry, and export actions open the same Pro sheet.
- Access enforcement returns the planner to today when necessary, preserving the old day's autosave. ExportManager also checks entitlements before requesting EventKit access.
- Purchase cancellation, pending approval, verification failure, unavailable products, and restore errors have separate outcomes. A pending payment never unlocks access early.
- Active subscribers see their access state and subscription management. Lifetime owners are not offered another purchase.

## Local testing

`TimeBoxedTests/Pro.storekit` contains the requested test prices. It is included only in the test bundle and does not replace the production App Store catalog. `ProPurchaseTests` starts an isolated StoreKit test session to verify free export denial, monthly purchase, expiration, lifetime purchase, restore, and refund. It also covers history access around a local midnight boundary.

For interactive purchase testing in Xcode, select `TimeBoxedTests/Pro.storekit` in Edit Scheme → Run → Options → StoreKit Configuration. Use Xcode's transaction manager for pending approval, refund, and renewal scenarios. Return the scheme to None before testing with an App Store sandbox account or TestFlight. Use a real published policy URL to enable the purchase buttons.

Before release, check the purchase sheet on small iPhones, iPad, larger text sizes, and VoiceOver; verify sandbox purchases, restore on a second device, pending approval, canceled payment, offline launch, expiration, and refunds. No live charge should be needed during this testing.

## Verification completed

- Simulator build succeeds.
- All 9 XCTest tests passed on iOS 17.5, including both prices/products, purchase, expiration, lifetime, restore, refund, and denied free exports.
- Visually checked the blurred calendar and centered Unlock History button, and opened the Pro sheet on iPhone 15 Pro in dark mode. The sheet displayed the local StoreKit $0.99/month and $9.99 lifetime options.
- iOS 26.3 StoreKit tests could not load their configuration; this matches the issue described in [Apple's StoreKit Test forum](https://developer.apple.com/forums/tags/storekittest?page=2). Use iOS 17.5 for the bundled test suite on this machine until its newer simulator runtime is updated.
- Live App Store sandbox purchases remain release verification work; the public Privacy Policy link is configured.

## Suggested future Pro features

1. Reusable day templates and recurring routines: the most useful next addition for daily use.
2. Weekly reviews: planned focus hours, category totals, and trends derived from saved days.
3. Batch export: send an entire day to Calendar or Reminders, with duplicate prevention.
4. Searchable history and tags: find past projects or tasks quickly.
5. iCloud sync and backup: useful across devices, but requires additional storage and conflict handling.

These are ideas, not promises on the current paywall. At $9.99, lifetime costs approximately ten monthly payments, so it is a generous early-supporter price; reconsider it as recurring service costs grow.
