/**
 * THE REFUSAL GOES AWAY BY ITSELF, AND COMES BACK WHEN IT HAPPENS AGAIN (#707).
 *
 * The owner raised the display separately from the bug: a red sentence parked
 * in the composer's toolbar is as loud as the message box, it stays for the
 * life of the composer, and it is truncated to whatever width is left. What
 * replaces it is the updater's idiom — an anchored caption that dismisses
 * itself — and two things about it are easy to get wrong and impossible to
 * notice:
 *
 *   - a caption that hides after a timeout and keys on the SENTENCE will not
 *     come back for a second press that fails the same way, which is the
 *     commonest case there is;
 *   - and it must not eat a click on the toolbar it floats over.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DictationNotice } from "@/components/dictation-notice";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: { root: Root; host: HTMLElement }[] = [];

function mount(node: React.ReactNode): { host: HTMLElement; render: (next: React.ReactNode) => void } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push({ root, host });
  act(() => root.render(node));
  return { host, render: (next) => act(() => root.render(next)) };
}

/** Long enough to be a real timeout, short enough that a test can wait it out. */
const DISMISS_MS = 20;

const settle = async (ms: number): Promise<void> => {
  await act(async () => {
    await new Promise((done) => setTimeout(done, ms));
  });
};

const noticeIn = (host: HTMLElement): HTMLElement | null => host.querySelector('[data-slot="dictation-notice"]');

afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
});

afterAll(async () => {
  await settle(0);
  await GlobalRegistrator.unregister();
});

test("nothing is drawn when there is nothing to say", () => {
  const { host } = mount(<DictationNotice error={undefined} dismissMs={DISMISS_MS} />);
  expect(noticeIn(host)).toBeNull();
});

test("the sentence is shown whole, not shortened or reworded", () => {
  // AND NOT REPLACED BY A FRIENDLIER GUESS. Some of these sentences are honest
  // and unhelpful because a browser's WebSocket error carries no reason; this
  // component's job is to say the one it was handed.
  const said = "The connection to the transcription service failed. Press the button to try again.";
  const { host } = mount(<DictationNotice error={{ text: said, seq: 1 }} dismissMs={DISMISS_MS} />);
  expect(noticeIn(host)?.textContent).toBe(said);
});

test("it leaves on its own, which is the whole complaint about what it replaces", async () => {
  const { host } = mount(<DictationNotice error={{ text: "It failed.", seq: 1 }} dismissMs={DISMISS_MS} />);
  expect(noticeIn(host)).not.toBeNull();
  await settle(DISMISS_MS + 10);
  expect(noticeIn(host)).toBeNull();
});

test("a second press that fails the SAME WAY says so again", async () => {
  // THE TRAP. Keyed on the sentence, this second refusal would be silent — and
  // silence after a press reads as the press not registering.
  const said = "The connection to the transcription service failed. Press the button to try again.";
  const { host, render } = mount(<DictationNotice error={{ text: said, seq: 1 }} dismissMs={DISMISS_MS} />);
  await settle(DISMISS_MS + 10);
  expect(noticeIn(host)).toBeNull();

  // The next press clears the error before it fails again — which is what the
  // hook does — and the refusal that follows is a different one.
  render(<DictationNotice error={undefined} dismissMs={DISMISS_MS} />);
  render(<DictationNotice error={{ text: said, seq: 2 }} dismissMs={DISMISS_MS} />);
  expect(noticeIn(host)?.textContent).toBe(said);
});

test("a dictation that works clears it rather than leaving it up", () => {
  const { host, render } = mount(<DictationNotice error={{ text: "It failed.", seq: 1 }} dismissMs={DISMISS_MS} />);
  expect(noticeIn(host)).not.toBeNull();
  render(<DictationNotice error={undefined} dismissMs={DISMISS_MS} />);
  expect(noticeIn(host)).toBeNull();
});

test("it is announced politely and cannot swallow a click on the toolbar under it", () => {
  const { host } = mount(<DictationNotice error={{ text: "It failed.", seq: 1 }} dismissMs={DISMISS_MS} />);
  const notice = noticeIn(host);
  expect(notice?.getAttribute("role")).toBe("status");
  expect(notice?.getAttribute("aria-live")).toBe("polite");
  // IT FLOATS OVER THE COMPOSER. A caption that ate a press of the send button
  // would be a worse bug than the one it is explaining.
  expect(notice?.className).toContain("pointer-events-none");
});
