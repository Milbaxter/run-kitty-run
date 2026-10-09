import XCTest
import UIKit
import WebKit
import StoreKit
import StoreKitTest
@testable import App

// StorePlugin.swift's StoreKit side (StoreBridge) against StoreKit Testing (Products.storekit, no App Store, no
// dialogs). The server half (verifying and crediting what these return) is scripts/iap-test.mjs.
// The last two drive the game's own WebView: the JS -> Capacitor -> StorePlugin bridge, and (with a local server,
// TEST_RUNNER_RKR_E2E_SERVER=http://127.0.0.1:8099 running with APPLE_IAP_XCODE=1) the purchase screen end to end,
// with screenshots attached to the test results.
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

    // A real cancel comes back as PurchaseResult.userCancelled ("cancelled"); StoreKit Testing can't make one without
    // a dialog, so: the error StoreKit may throw instead maps to CANCELLED, and a failed payment leaves nothing behind.
    func testCancelMapsToCancelledAndLeavesNothing() async throws {
        XCTAssertEqual(StoreBridge.code(StoreKitError.userCancelled).0, "CANCELLED")
        XCTAssertEqual(StoreBridge.code(StoreKitError.networkError(URLError(.notConnectedToInternet))).0, "NETWORK")
        XCTAssertEqual(StoreBridge.code(Product.PurchaseError.purchaseNotAllowed).0, "NOT_ALLOWED")
        session.failTransactionsEnabled = true
        session.failureError = .paymentCancelled
        _ = try? await buy()
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

    // ---- the game's WebView ----

    @MainActor
    private func gameWebView() async throws -> WKWebView {
        let vc = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.windows.first?.rootViewController as? GameViewController }.first
        let web = try XCTUnwrap(vc?.webView, "the game's web view")
        try await waitJS(web, "window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Store", "the Store plugin in the page")
        return web
    }

    // run async JS in the page (top level await, `return` the result)
    @MainActor
    private func js(_ web: WKWebView, _ body: String, _ args: [String: Any] = [:]) async throws -> Any? {
        try await web.callAsyncJavaScript(body, arguments: args, contentWorld: .page)
    }

    // wait until a JS expression is true (the CI simulator renders WebGL in software: everything is slow)
    @MainActor
    private func waitJS(_ web: WKWebView, _ expr: String, _ what: String, timeout: TimeInterval = 240) async throws {
        let end = Date().addingTimeInterval(timeout)
        var tries = 0
        while Date() < end {
            do {
                if let ok = try await web.callAsyncJavaScript("return !!(\(expr))", arguments: [:], contentWorld: .page) as? Bool, ok { return }
                if tries % 15 == 0 { NSLog("%@", "[StoreTests] waiting for \(what): no (url \(web.url?.absoluteString ?? "-"), loading \(web.isLoading))") }
            } catch {
                if tries % 15 == 0 { NSLog("%@", "[StoreTests] waiting for \(what): \(error) (url \(web.url?.absoluteString ?? "-"), loading \(web.isLoading))") }
            }
            tries += 1
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }
        let state = try? await web.callAsyncJavaScript(
            "return JSON.stringify({ box: (document.querySelector('.rka-box') || {}).textContent || null, button: (document.querySelector('.rkr-swag') || {}).className || null, title: document.title })",
            arguments: [:], contentWorld: .page) as? String
        NSLog("%@", "[StoreTests] gave up on \(what); page: \(state ?? "-")")
        XCTFail("timed out waiting for \(what)")
        throw XCTSkip("gave up on \(what)")
    }

    @MainActor
    private func attachScreenshot(_ name: String) {
        guard let window = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.windows.first }).first else { return }
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        let a = XCTAttachment(image: image)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    @MainActor
    func testJavaScriptReachesTheStorePluginThroughTheBridge() async throws {
        let web = try await gameWebView()
        let out = try await js(web, """
            const S = window.Capacitor.Plugins.Store;   // what public/js/store.js uses
            const status = await S.status();
            const products = (await S.products({ ids })).products;
            const bought = await S.purchase({ id: ids[0], appAccountToken: token });
            const unfinished = (await S.unfinished()).transactions;
            await S.finish({ transactionId: bought.transaction.transactionId });
            let bad = null;
            try { await S.purchase({ id: ids[0] }); } catch (e) { bad = e.code || 'error'; }
            return JSON.stringify({ status, products, bought, unfinished, bad });
            """, ["ids": Self.ids, "token": token.uuidString])
        let d = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(XCTUnwrap(out as? String).utf8)) as? [String: Any])
        XCTAssertEqual((d["status"] as? [String: Any])?["supported"] as? Bool, true)
        let products = try XCTUnwrap(d["products"] as? [[String: Any]])
        XCTAssertEqual(products.map { $0["displayPrice"] as? String }, ["$0.99", "$4.99", "$9.99", "$19.99"])
        let bought = try XCTUnwrap(d["bought"] as? [String: Any])
        XCTAssertEqual(bought["status"] as? String, "success")
        let t = try XCTUnwrap(bought["transaction"] as? [String: Any])
        XCTAssertEqual(t["appAccountToken"] as? String, token.uuidString.lowercased())
        XCTAssertTrue((d["unfinished"] as? [[String: Any]] ?? []).contains { $0["transactionId"] as? String == t["transactionId"] as? String })
        XCTAssertEqual(d["bad"] as? String, "FAILED", "no purchase without an account token")
    }

    @MainActor
    func testPurchaseScreenEndToEnd() async throws {
        guard let server = ProcessInfo.processInfo.environment["RKR_E2E_SERVER"] else {
            throw XCTSkip("needs a local server: TEST_RUNNER_RKR_E2E_SERVER")
        }
        for await r in Transaction.unfinished { await r.unsafePayloadValue.finish() }
        let web = try await gameWebView()
        // the game against the local server, lightest graphics (software rendering on CI)
        _ = try await js(web, "localStorage.setItem('rkr-settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('rkr-settings') || '{}'), gfx: 'ultra' })); localStorage.removeItem('rkr-acct');")
        let page = try XCTUnwrap(URL(string: "capacitor://localhost/?account=" + (server.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? server)))
        web.load(URLRequest(url: page))
        try await waitJS(web, "document.querySelector('.rkr-swag') && !document.querySelector('.rkr-swag').classList.contains('rkr-hidden')", "the swag button (server config)")
        // (opens the swag dialog; again if a redraw of the title screen swallowed the first click)
        try await waitJS(web, "document.querySelector('.rka-box') || (document.querySelector('.rkr-swag').click(), false)", "the swag dialog", timeout: 120)
        // (an earlier test's purchase may have been delivered at launch: then the account is active, packs via ADD MORE)
        try await waitJS(web, "document.querySelectorAll('.rka-pack').length === 4 || ([...document.querySelectorAll('.rka-box button')].find((b) => b.textContent === 'ADD MORE') || { click() {} }).click()", "the four packs")
        let texts = try await js(web, "return [...document.querySelectorAll('.rka-pack')].map((b) => b.textContent).join('|')") as? String ?? ""
        XCTAssertTrue(texts.contains("$0.99") && texts.contains("$19.99"), texts)
        try await Task.sleep(nanoseconds: 3_000_000_000)
        attachScreenshot("purchase-screen")
        _ = try await js(web, "document.querySelectorAll('.rka-pack')[1].click()")
        try await waitJS(web, "/THANK YOU/.test((document.querySelector('.rka-box h2') || {}).textContent || '') || /did not|Could not|wrong/.test((document.querySelector('.rka-msg') || {}).textContent || '')", "the purchase result")
        let msg = try await js(web, "return document.querySelector('.rka-msg').textContent") as? String ?? ""
        try await Task.sleep(nanoseconds: 3_000_000_000)
        attachScreenshot("purchase-done")
        XCTAssertTrue(msg.contains("+4.99"), "message: \(msg)")
        let total = (try await js(web, "return (/now ([0-9.]+)/.exec(document.querySelector('.rka-msg').textContent) || [])[1] || ''") as? String) ?? ""
        XCTAssertFalse(total.isEmpty)
        let left = await StoreBridge.unfinished()
        XCTAssertTrue(left.isEmpty, "credited by the server, then finished")
        // reinstall: the session is gone, the account is found again at launch
        _ = try await js(web, "localStorage.removeItem('rkr-acct')")
        web.load(URLRequest(url: page))
        try await waitJS(web, "((document.querySelector('.rkr-swag small') || {}).textContent || '').startsWith('\(total)')", "the account found again after a reinstall")
    }
}
