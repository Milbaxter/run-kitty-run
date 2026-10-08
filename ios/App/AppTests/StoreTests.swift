import XCTest
import StoreKit
import StoreKitTest
@testable import App

// StorePlugin.swift's StoreKit side (StoreBridge) against StoreKit Testing (Products.storekit, no App Store, no
// dialogs). The server half (verifying and crediting what these return) is scripts/iap-test.mjs.
// Run: xcodebuild test -project ios/App/App.xcodeproj -scheme App -destination 'platform=iOS Simulator,name=...'
final class StoreTests: XCTestCase {
    static let ids = ["io.runkittyrun.app.swag.small", "io.runkittyrun.app.swag.medium",
                      "io.runkittyrun.app.swag.large", "io.runkittyrun.app.swag.mega"]
    var session: SKTestSession!
    let token = UUID()

    override func setUpWithError() throws {
        session = try SKTestSession(configurationFileNamed: "Products")
        session.resetToDefaultState()
        session.clearTransactions()
        session.disableDialogs = true
        session.askToBuyEnabled = false
        session.storefront = "USA"
    }

    override func tearDown() async throws {
        for await r in Transaction.unfinished { await r.unsafePayloadValue.finish() }
        session.clearTransactions()
    }

    private func buy(_ id: String = ids[0]) async throws -> [String: Any] {
        try await StoreBridge.purchase(id, token: token, scene: nil)
    }

    func testProductsComeWithLocalizedPricesInCatalogOrder() async throws {
        let products = try await StoreBridge.products(Self.ids)
        XCTAssertEqual(products.map { $0["id"] as? String }, Self.ids)
        XCTAssertEqual(products.map { $0["displayPrice"] as? String }, ["$0.99", "$4.99", "$9.99", "$19.99"])
        XCTAssertEqual(products.first?["displayName"] as? String, "Swag Pack")
        XCTAssertEqual(products.first?["currency"] as? String, "USD")
    }

    func testUnknownProductIsNotFound() async throws {
        do { _ = try await StoreBridge.purchase("io.runkittyrun.app.nope", token: token, scene: nil); XCTFail("bought nothing?") }
        catch { XCTAssertEqual(StoreBridge.code(error).0, "NOT_FOUND") }
    }

    func testSuccessfulPurchaseIsSignedCarriesTheAccountAndStaysUnfinishedUntilFinished() async throws {
        let r = try await buy()
        XCTAssertEqual(r["status"] as? String, "success")
        let t = try XCTUnwrap(r["transaction"] as? [String: Any])
        XCTAssertEqual((t["jws"] as? String)?.split(separator: ".").count, 3, "a JWS for the server")
        XCTAssertEqual(t["appAccountToken"] as? String, token.uuidString.lowercased())
        XCTAssertEqual(t["productId"] as? String, Self.ids[0])
        XCTAssertEqual(t["environment"] as? String, "Xcode")
        XCTAssertEqual(t["verified"] as? Bool, true)
        XCTAssertEqual(t["revoked"] as? Bool, false)
        let id = try XCTUnwrap(t["transactionId"] as? String)
        // not finished by the app on its own: the server credits it first
        let unfinished = await StoreBridge.unfinished()
        XCTAssertTrue(unfinished.contains { $0["transactionId"] as? String == id })
        let finished = await StoreBridge.finish(try XCTUnwrap(UInt64(id)))
        XCTAssertTrue(finished)
        let after = await StoreBridge.unfinished()
        XCTAssertFalse(after.contains { $0["transactionId"] as? String == id })
        let again = await StoreBridge.finish(try XCTUnwrap(UInt64(id)))
        XCTAssertFalse(again, "finishing twice is harmless")
    }

    func testAskToBuyIsPendingThenArrivesWhenApproved() async throws {
        session.askToBuyEnabled = true
        let r = try await buy()
        XCTAssertEqual(r["status"] as? String, "pending")
        let before = await StoreBridge.unfinished()
        XCTAssertTrue(before.isEmpty, "nothing to deliver while waiting for approval")
        let pending = try XCTUnwrap(session.allTransactions().last)
        // the approval arrives through Transaction.updates (StorePlugin forwards those to the game)
        let arrived = expectation(description: "approved transaction arrives through Transaction.updates")
        let listener = Task {
            for await update in Transaction.updates where update.unsafePayloadValue.productID == Self.ids[0] {
                XCTAssertEqual(StoreBridge.payload(update)["appAccountToken"] as? String, self.token.uuidString.lowercased())
                arrived.fulfill()
                return
            }
        }
        try session.approveAskToBuyTransaction(identifier: pending.identifier)
        await fulfillment(of: [arrived], timeout: 30)
        listener.cancel()
        let after = await StoreBridge.unfinished()
        XCTAssertEqual(after.count, 1, "approved: waiting in Transaction.unfinished for the server")
    }

    func testAskToBuyDeclinedDeliversNothing() async throws {
        session.askToBuyEnabled = true
        _ = try await buy()
        let pending = try XCTUnwrap(session.allTransactions().last)
        try session.declineAskToBuyTransaction(identifier: pending.identifier)
        try await Task.sleep(nanoseconds: 1_000_000_000)
        let after = await StoreBridge.unfinished()
        XCTAssertTrue(after.isEmpty)
    }

    func testFailedPurchaseThrowsACodeAndChargesNothing() async throws {
        session.failTransactionsEnabled = true
        session.failureError = .unknown
        do { _ = try await buy(); XCTFail("should have failed") }
        catch {
            let code = StoreBridge.code(error).0
            XCTAssertTrue(["FAILED", "NETWORK", "NOT_ALLOWED"].contains(code), "code \(code) for \(error)")
        }
        let after = await StoreBridge.unfinished()
        XCTAssertTrue(after.isEmpty)
    }

    func testCancelledPaymentIsReportedAsCancelled() async throws {
        session.failTransactionsEnabled = true
        session.failureError = .paymentCancelled
        do {
            let r = try await buy()
            XCTAssertEqual(r["status"] as? String, "cancelled")
        } catch {
            XCTAssertEqual(StoreBridge.code(error).0, "CANCELLED", "\(error)")
        }
        let after = await StoreBridge.unfinished()
        XCTAssertTrue(after.isEmpty)
    }

    func testRefundShowsTheTransactionRevokedInHistory() async throws {
        let r = try await buy(Self.ids[1])
        let id = try XCTUnwrap((r["transaction"] as? [String: Any])?["transactionId"] as? String)
        _ = await StoreBridge.finish(try XCTUnwrap(UInt64(id)))
        try session.refundTransaction(identifier: try XCTUnwrap(UInt(id)))
        var revoked = false
        for _ in 0..<20 where !revoked {
            revoked = await StoreBridge.history(limit: 50).contains { $0["transactionId"] as? String == id && $0["revoked"] as? Bool == true }
            if !revoked { try await Task.sleep(nanoseconds: 500_000_000) }
        }
        XCTAssertTrue(revoked, "a refunded purchase comes back revoked (Restore purchases sends it to the server)")
    }

    func testFinishedConsumablesStayInHistoryOnIOS18() async throws {
        guard #available(iOS 18.0, *) else { throw XCTSkip("SKIncludeConsumableInAppPurchaseHistory needs iOS 18") }
        let r = try await buy()
        let id = try XCTUnwrap((r["transaction"] as? [String: Any])?["transactionId"] as? String)
        _ = await StoreBridge.finish(try XCTUnwrap(UInt64(id)))
        let history = await StoreBridge.history(limit: 50)
        XCTAssertTrue(history.contains { $0["transactionId"] as? String == id })
    }

    func testAppTransactionIdentifiesTheAppStoreAccount() async throws {
        do {
            let a = try await StoreBridge.appTransaction(refresh: false)
            XCTAssertEqual((a["jws"] as? String)?.split(separator: ".").count, 3)
            XCTAssertFalse((a["appTransactionId"] as? String ?? "").isEmpty)
            XCTAssertEqual(a["environment"] as? String, "Xcode")
        } catch {
            throw XCTSkip("no app transaction under StoreKit Testing here: \(error)")
        }
    }

    func testPluginIsRegisteredWithTheBridge() throws {
        let plugin = StorePlugin()
        XCTAssertEqual(plugin.jsName, "Store")
        XCTAssertEqual(Set(plugin.pluginMethods.map { $0.name }),
                       ["status", "products", "appTransaction", "purchase", "unfinished", "history", "finish"])
    }
}
