import { afterEach, expect, test } from "bun:test";
import { flush, installTestDom, mount, press } from "@/test/dom";
import { LoginOfferToggle, PasswordManagerToggles } from "./browser-logins-section";

installTestDom();

afterEach(() => {
  delete (window as { telarDesktop?: unknown }).telarDesktop;
});

function shellWith(stored: { offerAfterSignIn: boolean }) {
  const writes: unknown[] = [];
  (window as { telarDesktop?: unknown }).telarDesktop = {
    browser: {
      loginOfferPrefs: async (patch?: { offerAfterSignIn?: boolean }) => {
        if (patch?.offerAfterSignIn !== undefined) {
          writes.push(patch);
          stored.offerAfterSignIn = patch.offerAfterSignIn;
        }
        return { ...stored };
      },
    },
  };
  return writes;
}

test("the offer after sign-in shows off, and switching it on is saved in the shell", async () => {
  const writes = shellWith({ offerAfterSignIn: false });
  const { host } = await mount(<LoginOfferToggle />);
  await flush(() => Boolean(host.querySelector('[role="switch"]')));
  const toggle = host.querySelector('[role="switch"]')!;
  expect(host.textContent).toContain("Offer to remember after you sign in");
  expect(toggle.getAttribute("aria-checked")).toBe("false");

  await press(toggle);
  await flush(() => toggle.getAttribute("aria-checked") === "true");
  expect(writes).toEqual([{ offerAfterSignIn: true }]);
});

test("a shell without the setting shows no toggle", async () => {
  (window as { telarDesktop?: unknown }).telarDesktop = { browser: {} };
  const { host } = await mount(<LoginOfferToggle />);
  await flush();
  expect(host.querySelector('[role="switch"]')).toBeNull();
});

function shellWithPasswordManager(stored: { enabled: boolean }) {
  const writes: unknown[] = [];
  (window as { telarDesktop?: unknown }).telarDesktop = {
    browser: {
      passwordManager: async (patch?: { enabled?: boolean }) => {
        if (patch?.enabled !== undefined) {
          writes.push(patch);
          stored.enabled = patch.enabled;
        }
        return { ...stored };
      },
      loginOfferPrefs: async () => ({ offerAfterSignIn: false }),
    },
  };
  return writes;
}

const switches = (host: Element) => [...host.querySelectorAll('[role="switch"]')];

test("the password manager switch is saved in the shell, and the remember-after-sign-in row shows only while it is on", async () => {
  const writes = shellWithPasswordManager({ enabled: true });
  const { host } = await mount(<PasswordManagerToggles />);
  await flush(() => switches(host).length === 2);
  expect(host.textContent).toContain("Use a password manager in the browser");
  expect(host.textContent).toContain("Offer to remember after you sign in");

  await press(switches(host)[0]!);
  await flush(() => switches(host).length === 1);
  expect(writes).toEqual([{ enabled: false }]);
  expect(host.textContent).not.toContain("Offer to remember after you sign in");

  await press(switches(host)[0]!);
  await flush(() => switches(host).length === 2);
  expect(writes).toEqual([{ enabled: false }, { enabled: true }]);
});

test("a shell without the switch keeps the remember-after-sign-in row alone", async () => {
  (window as { telarDesktop?: unknown }).telarDesktop = { browser: { loginOfferPrefs: async () => ({ offerAfterSignIn: false }) } };
  const { host } = await mount(<PasswordManagerToggles />);
  await flush(() => switches(host).length === 1);
  expect(host.textContent).toContain("Offer to remember after you sign in");
  expect(host.textContent).not.toContain("Use a password manager");
});
