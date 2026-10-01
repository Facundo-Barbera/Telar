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

test("a sent image shows as a thumbnail and a sent file as a download link", async () => {
  const { host } = await mount(message("session_1"));
  const thumb = host.querySelector<HTMLImageElement>('button[aria-label="Open Screenshot.png"] img');
  expect(thumb?.getAttribute("src")).toBe("/api/sessions/session_1/attachments/att_1");
  const link = host.querySelector<HTMLAnchorElement>("a[download]");
  expect(link?.getAttribute("href")).toBe("/api/sessions/session_1/attachments/att_2");
  expect(link?.getAttribute("download")).toBe("notes.pdf");
});

test("clicking a thumbnail opens the image full size", async () => {
  const { host } = await mount(message("session_1"));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Open Screenshot.png"]')!.click());
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.querySelector("img")?.getAttribute("src")).toBe("/api/sessions/session_1/attachments/att_1");
});

test("with no session to fetch from, attachments stay plain chips", async () => {
  const { host } = await mount(message());
  expect(host.textContent).toContain("Screenshot.png");
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelector("a")).toBeNull();
});
