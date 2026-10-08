// iOS in-app purchases (App Store): the swag packs. Shared by the app (store.js / account.js, which show Apple's own
// localized prices next to these) and the server (accounts.js, which credits `credit` per verified transaction:
// the number added to the player's swag total, in the same cents as a web payment). The credit is fixed per product,
// whatever the storefront's price or currency, and the server never takes an amount from the app.
// Product IDs are permanent in App Store Connect: never reuse or rename one, add new ones instead.
// All consumable: buy as often as you like, the total only goes up (until a refund).
const IAP_PRODUCTS = [
  { id: 'io.runkittyrun.app.swag.small', credit: 99, name: 'Swag Pack', price: '0.99' },
  { id: 'io.runkittyrun.app.swag.medium', credit: 499, name: 'Big Swag Pack', price: '4.99' },
  { id: 'io.runkittyrun.app.swag.large', credit: 999, name: 'Huge Swag Pack', price: '9.99' },
  { id: 'io.runkittyrun.app.swag.mega', credit: 1999, name: 'Legendary Swag Pack', price: '19.99' },
];
const IAP_BY_ID = new Map(IAP_PRODUCTS.map((p) => [p.id, p]));

export { IAP_PRODUCTS, IAP_BY_ID };
