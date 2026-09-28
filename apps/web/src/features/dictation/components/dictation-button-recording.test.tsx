// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { installDictationFakes, live, sent, tracks, tokenCalls, knobs, results, roots, Box, mounted, micIn, draftOf, press } from "./dictation-button-fakes";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  // React's scheduler reads `window.event` in a queued task; unregistering first throws.
  await act(async () => {
    await new Promise((settle) => setTimeout(settle, 0));
  });
  await GlobalRegistrator.unregister();
});

installDictationFakes();

describe("the mic button on a composer", () => {
  test("interim words go into the draft React owns and are replaced in place", async () => {
    const host = await mounted(<Box kind="session" />);
    const button = micIn(host);

    await press(button);
    live!.open();
    expect(button.getAttribute("aria-label")).toBe("Stop dictating");

    live!.say(results("fix", false));
    expect(draftOf(host)).toBe("fix ");
    live!.say(results("fix the", false));
    expect(draftOf(host)).toBe("fix the ");

    live!.say(results("fix the failing test", true));
    expect(draftOf(host)).toBe("fix the failing test ");

    live!.say(results("and push", false));
    expect(draftOf(host)).toBe("fix the failing test and push ");
    live!.say(results("and push it", true));
    expect(draftOf(host)).toBe("fix the failing test and push it ");
  });

  test("nothing unconfirmed is printed beside the button any more", async () => {
    const host = await mounted(<Box kind="session" />);
    const button = micIn(host);
    await press(button);
    live!.open();
    live!.say(results("in the box", false));

    expect(draftOf(host)).toBe("in the box ");
    expect(button.parentElement!.textContent).toBe("Listening");
  });

  test("a person typing mid-guess keeps their keystrokes and the dictation carries on", async () => {
    const host = await mounted(<Box kind="session" />);
    await press(micIn(host));
    live!.open();
    live!.say(results("recording", false));
    expect(draftOf(host)).toBe("recording ");

    const editable = host.querySelector<HTMLElement>('[data-slot="composer-editor"]')!;
    act(() => {
      editable.textContent = "typed over it";
      editable.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(draftOf(host)).toBe("typed over it");

    live!.say(results("recording now", false));
    expect(draftOf(host)).toContain("typed over it");
    expect(draftOf(host)).toContain("recording now");
  });

  test("it opens the socket with the token it was just minted, as the bearer subprotocol", async () => {
    const host = await mounted(<Box kind="session" />);
    await press(micIn(host));
    expect(tokenCalls).toBe(1);
    expect(live!.protocols).toEqual(["bearer", "jwt-abc"]);
    expect(new URL(live!.url).searchParams.get("access_token")).toBeNull();
  });

  test("and it primes the recogniser with the glossary the Mac sent (#581)", async () => {
    const host = await mounted(<Box kind="session" />);
    await press(micIn(host));
    expect(new URL(live!.url).searchParams.getAll("keyterm")).toEqual(["Telar", "Zarigüeya"]);
  });

  test("a Mac that sends no glossary still opens the socket", async () => {
    knobs.keyterms = undefined;
    const host = await mounted(<Box kind="session" />);
    await press(micIn(host));
    expect(live).toBeDefined();
    expect(new URL(live!.url).searchParams.has("keyterm")).toBe(false);
  });

  test("audio only goes up once the socket is open, so the container header is not lost", async () => {
    const host = await mounted(<Box kind="session" />);
    await press(micIn(host));
    // A chunk before `onopen` would be the WebM header, and losing it loses the stream.
    expect(sent).toHaveLength(0);
    live!.open();
    expect(sent).toHaveLength(0);
  });

  test("pressing again stops, flushes the tail, and puts the microphone down", async () => {
    const host = await mounted(<Box kind="session" />);
    const button = micIn(host);
    await press(button);
    live!.open();
    const socket = live!;

    await press(button);
    expect(button.getAttribute("aria-label")).toBe("Dictate");
    expect(socket.frames).toContain(JSON.stringify({ type: "CloseStream" }));
    expect(socket.readyState).toBe(3);
    expect(tracks.every((track) => track.stopped)).toBe(true);
  });

  test("leaving the screen mid-dictation releases the microphone", async () => {
    const host = await mounted(<Box kind="session" />);
    await press(micIn(host));
    live!.open();
    for (const { root, host: node } of roots.splice(0)) {
      act(() => root.unmount());
      node.remove();
    }
    expect(tracks.every((track) => track.stopped)).toBe(true);
    void host;
  });

  test("a refused microphone is said in the person's own terms, and nothing is left running", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const denial = new Error("Permission denied");
          denial.name = "NotAllowedError";
          throw denial;
        },
      },
    });
    const host = await mounted(<Box kind="session" />);
    const button = micIn(host);
    await press(button);
    expect(button.getAttribute("aria-label")).toBe("Dictate");
    expect(host.textContent).toContain("did not allow the microphone");
  });

  test("a refusal is a caption over the button, not a red sentence parked in the toolbar", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const denial = new Error("Permission denied");
          denial.name = "NotAllowedError";
          throw denial;
        },
      },
    });
    const host = await mounted(<Box kind="session" />);
    await press(micIn(host));
    const notice = host.querySelector('[data-slot="dictation-notice"]');
    expect(notice?.textContent).toContain("did not allow the microphone");
    expect(micIn(host).parentElement?.className).toContain("relative");
    expect(notice?.className).toContain("absolute");
  });

  describe("when the socket is refused and only the engine can say why", () => {
    function engineSays(answer: () => Response): void {
      const rest = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(typeof input === "object" && "url" in input ? input.url : input);
        return url.includes("/api/dictation/diagnose") ? answer() : rest(input, init);
      }) as typeof fetch;
    }

    async function fails(how: "onerror" | "onclose"): Promise<void> {
      await act(async () => {
        live?.[how]?.();
        await new Promise((settle) => setTimeout(settle, 0));
      });
    }

    const noticeIn = (host: HTMLElement): string => host.querySelector('[data-slot="dictation-notice"]')?.textContent ?? "";

    test("Deepgram's own words replace the sentence the browser could honestly say", async () => {
      engineSays(() =>
        Response.json({ fault: "refused", reason: "Deepgram refused the transcription connection: HTTP 400 — Keyterm limit exceeded." }),
      );
      const host = await mounted(<Box kind="session" />);
      await press(micIn(host));
      live?.open();
      await fails("onerror");
      expect(noticeIn(host)).toContain("Keyterm limit exceeded");
      expect(noticeIn(host)).not.toContain("The connection to the transcription service failed");
    });

    test("a close nobody asked for is diagnosed too, because the same refusal arrives either way", async () => {
      engineSays(() => Response.json({ fault: "refused", reason: "Deepgram refused the transcription connection: HTTP 403 — Project does not have access to the requested model." }));
      const host = await mounted(<Box kind="session" />);
      await press(micIn(host));
      live?.open();
      await fails("onclose");
      expect(noticeIn(host)).toContain("does not have access to the requested model");
    });

    test("an engine that cannot answer leaves the honest sentence alone rather than blanking it", async () => {
      engineSays(() => Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 }));
      const host = await mounted(<Box kind="session" />);
      await press(micIn(host));
      live?.open();
      await fails("onerror");
      expect(noticeIn(host)).toContain("The connection to the transcription service failed");
      expect(noticeIn(host)).toContain("Press the button to try again");
    });

    test("the honest sentence is shown at once and not held back waiting for the round trip", async () => {
      let answer: ((value: Response) => void) | undefined;
      const pending = new Promise<Response>((settle) => {
        answer = settle;
      });
      engineSays(() => pending as unknown as Response);
      const host = await mounted(<Box kind="session" />);
      await press(micIn(host));
      live?.open();
      await fails("onerror");
      expect(answer).toBeDefined();
      expect(noticeIn(host)).toContain("The connection to the transcription service failed");
      await act(async () => {
        answer?.(Response.json({ fault: "elsewhere", reason: "Deepgram accepted a connection from this Mac just now." }));
        await new Promise((settle) => setTimeout(settle, 0));
      });
      expect(noticeIn(host)).toContain("accepted a connection from this Mac");
    });
  });

  test("a Mac with a provider chosen but no key refuses with the engine's sentence, not a status", async () => {
    const settings = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(typeof input === "object" && "url" in input ? input.url : input);
      if (!url.includes("/api/dictation/token")) return settings(input, init);
      return Response.json({ error: { code: "conflict", message: "No Deepgram key is configured on this Mac, so dictation cannot start." } }, { status: 409 });
    }) as typeof fetch;
    const host = await mounted(<Box kind="session" />);
    await press(micIn(host));
    expect(host.textContent).toContain("No Deepgram key is configured");
  });

  test("a provider this browser cannot drive is refused by name rather than opening the wrong socket", async () => {
    const settings = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(typeof input === "object" && "url" in input ? input.url : input);
      if (!url.includes("/api/dictation/token")) return settings(input, init);
      return Response.json({ provider: "openai", token: "jwt-abc", expiresAt: Date.now() + 300_000 });
    }) as typeof fetch;
    const host = await mounted(<Box kind="session" />);
    await press(micIn(host));
    expect(live).toBeUndefined();
    expect(host.textContent).toContain("openai");
  });
});
