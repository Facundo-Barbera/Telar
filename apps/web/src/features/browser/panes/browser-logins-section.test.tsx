import { afterEach, expect, test } from "bun:test";
import { flush, installTestDom, mount, press } from "@/test/dom";
import { LoginOfferToggle } from "./browser-logins-section";

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
