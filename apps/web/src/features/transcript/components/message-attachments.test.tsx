import { expect, test } from "bun:test";
import { act } from "react";
import { installTestDom, mount } from "@/test/dom";
import { ConversationMessage } from "./conversation-message";
import { TranscriptSession } from "./message-attachments";

installTestDom();

const shot = { id: "att_1", name: "Screenshot.png", mediaType: "image/png", bytes: 4, path: "/tmp/shot.png" };
const notes = { id: "att_2", name: "notes.pdf", mediaType: "application/pdf", bytes: 9, path: "/tmp/notes.pdf" };

const message = (sessionId?: string) => (
  <TranscriptSession.Provider value={sessionId}>
    <ConversationMessage text="look" attachments={[shot, notes]} />
  </TranscriptSession.Provider>
);

const fireError = (image: Element | null | undefined) => act(async () => void image!.dispatchEvent(new Event("error")));

test("a sent image shows as a drawable thumbnail and a sent file as a download link", async () => {
  const { host } = await mount(message("session_1"));
  const thumb = host.querySelector<HTMLImageElement>('button[aria-label="Open Screenshot.png"] img');
  expect(thumb?.getAttribute("src")).toBe("/api/sessions/session_1/attachments/att_1?variant=display");
  const link = host.querySelector<HTMLAnchorElement>("a[download]");
  expect(link?.getAttribute("href")).toBe("/api/sessions/session_1/attachments/att_2");
  expect(link?.getAttribute("download")).toBe("notes.pdf");
});

test("clicking a thumbnail opens the image full size", async () => {
  const { host } = await mount(message("session_1"));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Open Screenshot.png"]')!.click());
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.querySelector("img")?.getAttribute("src")).toBe("/api/sessions/session_1/attachments/att_1?variant=display");
});

test("an image the browser cannot draw becomes a file chip that downloads, with no lightbox to open", async () => {
  const { host } = await mount(message("session_1"));
  await fireError(host.querySelector('button[aria-label="Open Screenshot.png"] img'));
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelector('button[aria-label="Open Screenshot.png"]')).toBeNull();
  const chip = host.querySelector<HTMLAnchorElement>('a[download="Screenshot.png"]');
  expect(chip?.getAttribute("href")).toBe("/api/sessions/session_1/attachments/att_1");
  expect(chip?.textContent).toContain("4 B");
});

test("a lightbox whose image fails closes and leaves the file chip", async () => {
  const { host } = await mount(message("session_1"));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Open Screenshot.png"]')!.click());
  await fireError(document.querySelector('[role="dialog"] img'));
  expect(document.querySelector('[role="dialog"] img')).toBeNull();
  expect(host.querySelector('a[download="Screenshot.png"]')).not.toBeNull();
});

test("with no session to fetch from, attachments stay plain chips", async () => {
  const { host } = await mount(message());
  expect(host.textContent).toContain("Screenshot.png");
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelector("a")).toBeNull();
});
