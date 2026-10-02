const { jsonPrefs } = require("../main/prefs");

const prefs = jsonPrefs(
  "login-offer-prefs.json",
  { offerAfterSignIn: false },
  (raw) => ({ offerAfterSignIn: raw.offerAfterSignIn === true }),
  "login offer prefs",
);

module.exports = { readLoginOfferPrefs: prefs.read, writeLoginOfferPrefs: prefs.write };
