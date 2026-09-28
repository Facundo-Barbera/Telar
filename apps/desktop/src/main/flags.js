const SMOKE = process.argv.includes("--smoke");

const DEV_BUILD = (() => {
  try {
    return require("../../package.json").telarDev === true;
  } catch {
    return false;
  }
})();
const OVERRIDE_URL = DEV_BUILD ? undefined : process.env.TELAR_DESKTOP_URL;

const E2E_USER_DATA = DEV_BUILD ? undefined : process.env.TELAR_DESKTOP_E2E_USER_DATA?.trim();

module.exports = { DEV_BUILD, E2E_USER_DATA, OVERRIDE_URL, SMOKE };
