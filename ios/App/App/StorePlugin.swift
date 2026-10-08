import Foundation
import UIKit
import StoreKit
import Capacitor

// In-app purchases (StoreKit 2) for the swag packs: the native half of public/js/store.js.
// Nothing is decided on the device: every signed transaction (jws) goes to the game server (server/accounts.js),
// which checks it with Apple's certificates and credits it once. Only then does the game call finish(). Until then
// StoreKit keeps it in Transaction.unfinished and hands it out again (next launch, Restore Purchases), so a crash or
// a dropped connection never loses a purchase. Ask to Buy approvals, purchases made elsewhere and refunds arrive
// through Transaction.updates, watched from launch.
enum StoreBridge {
    enum Failure: Error { case code(String, String) }

    // One transaction for the game: the signed JWS (what the server checks) plus a few fields to act on.
    static func payload(_ result: VerificationResult<Transaction>) -> [String: Any] {
        let t = result.unsafePayloadValue
        var verified = true
        if case .unverified = result { verified = false }
        var d: [String: Any] = [
            "jws": result.jwsRepresentation,
            "verified": verified,                      // StoreKit's own check (the server checks again)
            "transactionId": String(t.id),             // a string: UInt64 doesn't fit a JS number
            "productId": t.productID,
            "quantity": t.purchasedQuantity,
            "revoked": t.revocationDate != nil,
        ]
        if let token = t.appAccountToken { d["appAccountToken"] = token.uuidString.lowercased() }
        if #available(iOS 16.0, *) { d["environment"] = t.environment.rawValue }
        return d
    }

    // Product -> what the purchase screen shows: Apple's own localized name, description and price
    static func products(_ ids: [String]) async throws -> [[String: Any]] {
        let found = try await Product.products(for: ids)
        return ids.compactMap { id in found.first { $0.id == id } }.map { p in
            ["id": p.id, "displayName": p.displayName, "description": p.description, "displayPrice": p.displayPrice,
             "price": NSDecimalNumber(decimal: p.price).stringValue, "currency": p.priceFormatStyle.currencyCode]
        }
    }

    // The app transaction: proves which App Store account installed the app (the server keys the swag account by its
    // appTransactionId). refresh asks the App Store again, which may ask the player to sign in.
    @available(iOS 16.0, *)
    static func appTransaction(refresh: Bool) async throws -> [String: Any] {
        let result = refresh ? try await AppTransaction.refresh() : try await AppTransaction.shared
        let t = result.unsafePayloadValue
        return ["jws": result.jwsRepresentation, "environment": t.environment.rawValue, "appTransactionId": t.appTransactionID]
    }

    // status: "success" (with the transaction), "pending" (Ask to Buy / needs approval: it arrives later through
    // Transaction.updates), "cancelled" (the player backed out: nothing charged)
    @MainActor
    static func purchase(_ id: String, token: UUID?, scene: UIWindowScene?) async throws -> [String: Any] {
        guard let product = try await Product.products(for: [id]).first else {
            throw Failure.code("NOT_FOUND", "This item is not available right now.")
        }
        var options: Set<Product.PurchaseOption> = []
        if let token { options.insert(.appAccountToken(token)) }
        let result: Product.PurchaseResult
        if #available(iOS 17.0, *), let scene {
            result = try await product.purchase(confirmIn: scene, options: options)
        } else {
            result = try await product.purchase(options: options)
        }
        switch result {
        case .success(let verification): return ["status": "success", "transaction": payload(verification)]
        case .pending: return ["status": "pending"]
        case .userCancelled: return ["status": "cancelled"]
        @unknown default: return ["status": "pending"]
        }
    }

    // purchases the game hasn't finished yet (not yet credited by the server)
    static func unfinished() async -> [[String: Any]] {
        var out: [[String: Any]] = []
        for await result in Transaction.unfinished { out.append(payload(result)) }
        return out
    }

    // every purchase this App Store account made in the app, newest first, refunded ones too (finished consumables
    // are included on iOS 18+: Info.plist SKIncludeConsumableInAppPurchaseHistory)
    static func history(limit: Int) async -> [[String: Any]] {
        var all: [(Date, [String: Any])] = []
        for await result in Transaction.all { all.append((result.unsafePayloadValue.purchaseDate, payload(result))) }
        return all.sorted { $0.0 > $1.0 }.prefix(limit).map { $0.1 }
    }

    // the server has credited it (or it has nothing left to deliver): StoreKit stops handing it out
    static func finish(_ id: UInt64) async -> Bool {
        for await result in Transaction.unfinished where result.unsafePayloadValue.id == id {
            await result.unsafePayloadValue.finish()
            return true
        }
        return false
    }

    // StoreKit errors -> a short code the game turns into a message
    static func code(_ error: Error) -> (String, String) {
        if case Failure.code(let c, let m) = error { return (c, m) }
        if let e = error as? Product.PurchaseError {
            switch e {
            case .productUnavailable: return ("NOT_FOUND", "This item is not available right now.")
            case .purchaseNotAllowed: return ("NOT_ALLOWED", "Purchases are not allowed on this device.")
            default: return ("FAILED", e.localizedDescription)
            }
        }
        if let e = error as? StoreKitError {
            switch e {
            case .userCancelled: return ("CANCELLED", "Cancelled.")
            case .networkError: return ("NETWORK", "Could not reach the App Store.")
            case .notAvailableInStorefront: return ("NOT_FOUND", "This item is not available in your country.")
            default: return ("FAILED", e.localizedDescription)
            }
        }
        return ("FAILED", error.localizedDescription)
    }
}

@objc(StorePlugin)
public class StorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "StorePlugin"
    public let jsName = "Store"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "products", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unfinished", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "history", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
    ]
    private var updates: Task<Void, Never>?

    override public func load() {
        // From launch: Ask to Buy approvals, purchases from other devices / the App Store, refunds. Kept until the
        // game listens (retainUntilConsumed), and they stay in Transaction.unfinished anyway until finished.
        updates = Task.detached { [weak self] in
            for await result in Transaction.updates {
                self?.notifyListeners("transaction", data: StoreBridge.payload(result), retainUntilConsumed: true)
            }
        }
    }

    deinit { updates?.cancel() }

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        let (code, message) = StoreBridge.code(error)
        call.reject(message, code, error)
    }

    @objc func status(_ call: CAPPluginCall) {
        var supported = false
        if #available(iOS 16.0, *) { supported = true }
        call.resolve(["supported": supported, "canMakePayments": AppStore.canMakePayments])
    }

    @objc func products(_ call: CAPPluginCall) {
        let ids = call.getArray("ids", String.self) ?? []
        Task {
            do { call.resolve(["products": try await StoreBridge.products(ids)]) } catch { self.reject(call, error) }
        }
    }

    @objc func appTransaction(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *) else { return call.reject("Purchases need iOS 16 or later.", "UNSUPPORTED") }
        let refresh = call.getBool("refresh") ?? false
        Task {
            do { call.resolve(try await StoreBridge.appTransaction(refresh: refresh)) } catch { self.reject(call, error) }
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("No product.", "FAILED") }
        // the swag account the purchase is for (the server checks it): never buy without one
        guard let token = call.getString("appAccountToken").flatMap(UUID.init(uuidString:)) else {
            return call.reject("No account to buy for.", "FAILED")
        }
        Task { @MainActor in
            do {
                let scene = self.bridge?.viewController?.view.window?.windowScene
                call.resolve(try await StoreBridge.purchase(id, token: token, scene: scene))
            } catch { self.reject(call, error) }
        }
    }

    @objc func unfinished(_ call: CAPPluginCall) {
        Task { call.resolve(["transactions": await StoreBridge.unfinished()]) }
    }

    @objc func history(_ call: CAPPluginCall) {
        let limit = max(1, min(call.getInt("limit") ?? 20, 100))
        Task { call.resolve(["transactions": await StoreBridge.history(limit: limit)]) }
    }

    @objc func finish(_ call: CAPPluginCall) {
        guard let id = call.getString("transactionId").flatMap(UInt64.init) else { return call.reject("No transaction.", "FAILED") }
        Task { call.resolve(["finished": await StoreBridge.finish(id)]) }
    }
}
