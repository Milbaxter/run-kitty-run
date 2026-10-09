// iOS in-app purchases: the app's native Store plugin (ios/App/App/StorePlugin.swift, StoreKit 2). account.js shows the
// swag packs (shared/iap.js) with Apple's localized prices and sends every signed transaction to the server
// (server/accounts.js 'apple/*'), which checks it with Apple's certificates and credits it once; only then is it
// finished here. Web and Android: no store (null).
import { NATIVE, PLATFORM } from './platform.js';
import { IAP_PRODUCTS } from './shared/iap.js';

// (Capacitor's native bridge puts every registered plugin on Capacitor.Plugins, ours included: StorePlugin is
// registered before the page loads. There is no registerPlugin without the @capacitor/core bundle.)
const CAP = window.Capacitor;
const plugin = (NATIVE && PLATFORM === 'ios' && CAP && CAP.Plugins && CAP.Plugins.Store) || null;

const MESSAGES = {
  NOT_FOUND: 'This pack is not available right now. Try again later.',
  NOT_ALLOWED: 'Purchases are turned off on this device (Screen Time or parental controls).',
  NETWORK: 'Could not reach the App Store. Check your connection and try again.',
  UNSUPPORTED: 'Buying swag needs iOS 16 or later.',
  FAILED: 'The purchase did not go through. Try again in a moment.',
};

function createStore() {
  if (!plugin) return null;
  let products = null;   // [{ id, displayName, description, displayPrice, credit }] in IAP_PRODUCTS order
  return {
    // { supported (iOS 16+: the app transaction), canMakePayments }; null if the native side is missing (old build)
    async status() { try { return await plugin.status(); } catch { return null; } },
    // Apple's localized names and prices, for the packs the server credits (fetched once, again after a failure)
    async products() {
      if (products) return products;
      const r = await plugin.products({ ids: IAP_PRODUCTS.map((p) => p.id) });
      const got = new Map((r.products || []).map((p) => [p.id, p]));
      const list = IAP_PRODUCTS.filter((p) => got.has(p.id)).map((p) => ({ ...got.get(p.id), credit: p.credit }));
      if (list.length) products = list;
      return list;
    },
    appTransaction: (refresh = false) => plugin.appTransaction({ refresh }),
    // -> { status: 'success' (+ transaction) | 'pending' | 'cancelled' }; throws with .code on failure
    purchase: (id, appAccountToken) => plugin.purchase({ id, appAccountToken }),
    unfinished: async () => ((await plugin.unfinished()).transactions || []),
    history: async (limit = 20) => ((await plugin.history({ limit })).transactions || []),
    finish: (transactionId) => plugin.finish({ transactionId }).catch(() => null),
    // transactions arriving on their own: Ask to Buy approved, bought on another device, refunded
    onTransaction(fn) { plugin.addListener('transaction', fn); },
    message(e) { return (e && e.code === 'CANCELLED') ? 'No worries, nothing was charged.' : MESSAGES[e && e.code] || MESSAGES.FAILED; },
  };
}

export { createStore };
