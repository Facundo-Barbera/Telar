const { jsonPrefs } = require("../main/prefs");
const { passwordManagerEnabled } = require("./password-manager-prefs");

const prefs = jsonPrefs(
  "login-offer-prefs.json",
  { offerAfterSignIn: false },
  (raw) => ({ offerAfterSignIn: raw.offerAfterSignIn === true }),
  "login offer prefs",
);

const autoOfferEnabled = () => passwordManagerEnabled() && prefs.read().offerAfterSignIn;

module.exports = { autoOfferEnabled, readLoginOfferPrefs: prefs.read, writeLoginOfferPrefs: prefs.write };
