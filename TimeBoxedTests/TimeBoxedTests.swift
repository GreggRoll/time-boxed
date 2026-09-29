import XCTest
import StoreKit
import StoreKitTest
@testable import Time_Boxed

final class TimeBoxedTests: XCTestCase {
    func testLegacyDayDecodesWithoutInterval() throws {
        let json = #"{"priorities":["Ship it"],"brainDump":"","blocks":[{"id":"00000000-0000-0000-0000-000000000001","startMinute":750,"durationMinutes":30,"text":"Lunch"}]}"#
        let sheet = try JSONDecoder().decode(DaySheet.self, from: Data(json.utf8))

        XCTAssertNil(sheet.intervalMinutes)
        XCTAssertEqual(sheet.blocks.first?.startMinute, 750)
        XCTAssertEqual(sheet.blocks.first?.durationMinutes, 30)
    }

    @MainActor
    func testFilledDayKeepsItsIntervalAndBlocksWhenDefaultChanges() async throws {
        let fixture = try makeFixture(interval: 30)
        await fixture.store.waitForPendingOperations()
        let firstID = UUID()
        let secondID = UUID()
        fixture.store.sheet = DaySheet(
            blocks: [
                TimeBlock(id: firstID, startMinute: 12 * 60, durationMinutes: 30, text: "First"),
                TimeBlock(id: secondID, startMinute: 12 * 60 + 30, durationMinutes: 30, text: "Second")
            ],
            intervalMinutes: 30
        )
        let originalBlocks = fixture.store.sheet.blocks

        fixture.settings.setIntervalMinutes(60)
        let adopted = fixture.store.adoptDefaultIntervalIfEmpty(60)

        XCTAssertFalse(adopted)
        XCTAssertEqual(fixture.store.effectiveIntervalMinutes, 30)
        XCTAssertEqual(fixture.store.sheet.blocks, originalBlocks)
    }

    @MainActor
    func testEmptyDayAdoptsNewDefaultInterval() async throws {
        let fixture = try makeFixture(interval: 30)
        await fixture.store.waitForPendingOperations()

        fixture.settings.setIntervalMinutes(60)
        XCTAssertTrue(fixture.store.adoptDefaultIntervalIfEmpty(60))
        XCTAssertEqual(fixture.store.effectiveIntervalMinutes, 60)
        XCTAssertTrue(fixture.store.sheet.blocks.isEmpty)
    }

    @MainActor
    func testMergeAndUnmergeRoundTrip() async throws {
        let fixture = try makeFixture(interval: 30)
        await fixture.store.waitForPendingOperations()
        let first = TimeBlock(startMinute: 9 * 60, durationMinutes: 30, text: "Focus")
        let second = TimeBlock(startMinute: 9 * 60 + 30, durationMinutes: 30, text: "Focus")
        fixture.store.sheet = DaySheet(blocks: [first, second], intervalMinutes: 30)

        XCTAssertTrue(fixture.store.canMergeWithPrevious(blockID: second.id, intervalMinutes: 30))
        fixture.store.mergeWithPrevious(blockID: second.id, intervalMinutes: 30)
        XCTAssertEqual(fixture.store.sheet.blocks, [TimeBlock(id: first.id, startMinute: 9 * 60, durationMinutes: 60, text: "Focus")])

        fixture.store.unmerge(blockID: first.id, intervalMinutes: 30)
        XCTAssertEqual(fixture.store.sheet.blocks.map(\.startMinute), [9 * 60, 9 * 60 + 30])
        XCTAssertEqual(fixture.store.sheet.blocks.map(\.durationMinutes), [30, 30])
    }

    @MainActor
    func testInlineBlockBindingCreatesUpdatesAndFinalizesBlock() async throws {
        let fixture = try makeFixture(interval: 30)
        await fixture.store.waitForPendingOperations()
        let startMinute = 9 * 60
        let binding = fixture.store.blockBinding(at: startMinute, intervalMinutes: 30)

        XCTAssertEqual(binding.wrappedValue, "")
        XCTAssertTrue(fixture.store.sheet.blocks.isEmpty)

        binding.wrappedValue = "Deep work"

        XCTAssertEqual(fixture.store.sheet.blocks.count, 1)
        XCTAssertEqual(fixture.store.sheet.blocks.first?.startMinute, startMinute)
        XCTAssertEqual(fixture.store.sheet.blocks.first?.durationMinutes, 30)
        XCTAssertEqual(fixture.store.sheet.blocks.first?.text, "Deep work")

        binding.wrappedValue = ""
        XCTAssertEqual(fixture.store.sheet.blocks.count, 1)

        fixture.store.finalizeBlockEditing(at: startMinute)
        XCTAssertTrue(fixture.store.sheet.blocks.isEmpty)
    }

    func testPersistenceSavesLoadsAndRemovesDay() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("TimeBoxedPersistenceTests-\(UUID().uuidString)", isDirectory: true)
        let persistence = DayPersistence(storageDirectory: directory)
        let key = "2026-08-15"
        let sheet = DaySheet(
            priorities: ["Important"],
            blocks: [TimeBlock(startMinute: 600, durationMinutes: 60, text: "Deep work")],
            intervalMinutes: 60
        )

        let initialKeys = try await persistence.prepare()
        XCTAssertEqual(initialKeys, Set<String>())
        let saveResult = try await persistence.saveDay(sheet, key: key)
        guard case .saved = saveResult else { return XCTFail("Expected the day to be saved") }
        let loadedSheet = try await persistence.loadDay(key: key)
        XCTAssertEqual(loadedSheet, sheet)
        let savedKeys = try await persistence.prepare()
        XCTAssertEqual(savedKeys, Set([key]))

        let removalResult = try await persistence.saveDay(DaySheet(intervalMinutes: 60), key: key)
        guard case .removed = removalResult else { return XCTFail("Expected the empty day to be removed") }
        let removedSheet = try await persistence.loadDay(key: key)
        XCTAssertNil(removedSheet)
    }

    @MainActor
    func testSettingsNormalizeAndPersistSchedule() {
        let suiteName = "TimeBoxedSettingsTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.set(5 * 60 + 17, forKey: "planner.startMinute")
        defaults.set(22 * 60 + 7, forKey: "planner.endMinute")
        defaults.set(60, forKey: "planner.intervalMinutes")

        let settings = PlannerSettings(defaults: defaults)

        XCTAssertEqual(settings.startMinute, 5 * 60)
        XCTAssertEqual(settings.endMinute, 23 * 60)
        XCTAssertEqual(settings.slotStarts.first, 5 * 60)
        XCTAssertEqual(settings.slotStarts.last, 22 * 60)
    }

    @MainActor
    private func makeFixture(interval: Int) throws -> (settings: PlannerSettings, store: DayStore) {
        let suiteName = "TimeBoxedStoreTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defaults.set(interval, forKey: "planner.intervalMinutes")
        let settings = PlannerSettings(defaults: defaults)
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("TimeBoxedStoreTests-\(UUID().uuidString)", isDirectory: true)
        return (settings, DayStore(settings: settings, storageDirectory: directory))
    }
}


final class ProPurchaseTests: XCTestCase {
    func testAppBundleIncludesPrivacyPolicyToEnablePurchaseButtons() throws {
        let value = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "ProPrivacyPolicyURL") as? String)
        let url = try XCTUnwrap(URL(string: value))
        XCTAssertEqual(url.scheme, "https")
        XCTAssertNotNil(url.host)
        XCTAssertEqual(url.absoluteString, "https://greggroll.github.io/TimeBox/")
    }

    @MainActor
    func testProPurchasesExpirationRefundAndRestore() async throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "Pro", withExtension: "storekit"))
        let session = try SKTestSession(contentsOf: url)
        session.resetToDefaultState()
        session.disableDialogs = true
        session.clearTransactions()
        defer { session.clearTransactions() }

        let pro = ProStore()
        await pro.refreshEntitlements()
        XCTAssertFalse(pro.hasPro)
        await pro.loadProducts()
        XCTAssertEqual(pro.products.count, 2)
        let monthly = try XCTUnwrap(pro.products.first { $0.id == ProStore.monthlyID })
        let lifetime = try XCTUnwrap(pro.products.first { $0.id == ProStore.lifetimeID })
        XCTAssertEqual(monthly.price, Decimal(string: "0.99"))
        XCTAssertEqual(lifetime.price, Decimal(string: "9.99"))

        // Free exports fail before EventKit requests access or writes anything.
        for destination in [ExportDestination.calendar, .reminders] {
            do {
                _ = try await ExportManager().export(
                    block: TimeBlock(startMinute: 540, durationMinutes: 30, text: "Focus"),
                    on: Date(), destination: destination, proStore: pro
                )
                XCTFail("Free export should be denied")
            } catch ExportManagerError.proRequired { } catch { XCTFail("Unexpected error: \(error)") }
        }

        await pro.purchase(monthly)
        XCTAssertTrue(pro.hasPro)
        XCTAssertFalse(pro.hasLifetime)
        try session.expireSubscription(productIdentifier: ProStore.monthlyID)
        await waitForAccess(pro, expected: false)
        XCTAssertFalse(pro.hasPro)

        await pro.purchase(lifetime)
        XCTAssertTrue(pro.hasPro)
        XCTAssertTrue(pro.hasLifetime)
        let restored = ProStore()
        await restored.restore()
        XCTAssertTrue(restored.hasLifetime)
        let transaction = try XCTUnwrap(session.allTransactions().first { $0.productIdentifier == ProStore.lifetimeID })
        try session.refundTransaction(identifier: transaction.identifier)
        await waitForAccess(restored, expected: false)
        XCTAssertFalse(restored.hasPro)
    }

    @MainActor
    private func waitForAccess(_ pro: ProStore, expected: Bool) async {
        // StoreKit publishes test-session expiration/refund changes asynchronously.
        for _ in 0..<50 {
            await pro.refreshEntitlements()
            if pro.hasPro == expected { return }
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    func testHistoryAccessAcrossDaysAndTimeZones() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: -4 * 3600)!
        let today = Date(timeIntervalSince1970: 1_789_488_000)
        let yesterday = calendar.date(byAdding: .day, value: -1, to: today)!
        XCTAssertTrue(ProAccessPolicy.canView(today, hasPro: false, now: today, calendar: calendar))
        XCTAssertFalse(ProAccessPolicy.canView(yesterday, hasPro: false, now: today, calendar: calendar))
        XCTAssertTrue(ProAccessPolicy.canView(yesterday, hasPro: true, now: today, calendar: calendar))
        let midnight = calendar.startOfDay(for: today)
        XCTAssertFalse(ProAccessPolicy.canView(midnight.addingTimeInterval(-1), hasPro: false, now: midnight, calendar: calendar))
    }
}
