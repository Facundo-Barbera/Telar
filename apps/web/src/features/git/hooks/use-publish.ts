"use client";

import { useState } from "react";
import type { GitHubPullCreateRefusal, GitHubPullCreateResult, GitPushRefusal, GitPushResult } from "@telar/engine-client";
import { EngineApiError } from "@/platform/engine";

export type PublishVerbs = {
  sendPush: () => Promise<GitPushResult>;
  sendPullRequest: (input: { title: string; body?: string }) => Promise<GitHubPullCreateResult>;
};

/** The publish box's state: which arm is armed, the refusal each arm last got, and the pull request it opened. */
export function usePublish({ sendPush, sendPullRequest, onPublished, suggestion }: PublishVerbs & { onPublished: () => void; suggestion: string }) {
  const [armed, setArmed] = useState<"push" | "pull">();
  const [working, setWorking] = useState(false);
  const [pushProblem, setPushProblem] = useState<{ refusal: GitPushRefusal; message?: string }>();
  const [pullProblem, setPullProblem] = useState<{ refusal: GitHubPullCreateRefusal; message?: string; url?: string }>();
  const [opened, setOpened] = useState<{ url: string; number?: number }>();
  const [title, setTitle] = useState(suggestion);
  const [body, setBody] = useState("");

  const push = async () => {
    setWorking(true);
    setPushProblem(undefined);
    try {
      const result = await sendPush();
      if (result.pushed) {
        setArmed(undefined);
        onPublished();
        return;
      }
      setPushProblem({ refusal: result.refusal, ...(result.message ? { message: result.message } : {}) });
    } catch (cause) {
      setPushProblem({ refusal: "failed", message: cause instanceof EngineApiError ? cause.message : "The push could not be sent." });
    } finally {
      setWorking(false);
      setArmed(undefined);
    }
  };

  const openPull = async () => {
    setWorking(true);
    setPullProblem(undefined);
    try {
      const result = await sendPullRequest({ title, ...(body.trim() ? { body } : {}) });
      if (result.opened) {
        setArmed(undefined);
        setOpened({ url: result.url, ...(result.number ? { number: result.number } : {}) });
        onPublished();
        return;
      }
      setPullProblem({
        refusal: result.refusal,
        ...(result.message ? { message: result.message } : {}),
        ...(result.url ? { url: result.url } : {}),
      });
    } catch (cause) {
      setPullProblem({
        refusal: "failed",
        message: cause instanceof EngineApiError ? cause.message : "The pull request could not be sent.",
      });
    } finally {
      setWorking(false);
      setArmed(undefined);
    }
  };

  const armPush = () => {
    setPushProblem(undefined);
    setArmed("push");
  };
  const armPull = () => {
    setPullProblem(undefined);
    setTitle(suggestion);
    setArmed("pull");
  };

  return {
    armed,
    working,
    pushProblem,
    pullProblem,
    opened,
    title,
    body,
    setTitle,
    setBody,
    push,
    openPull,
    armPush,
    armPull,
    disarm: () => setArmed(undefined),
    dismissPush: () => setPushProblem(undefined),
    dismissPull: () => setPullProblem(undefined),
  };
}
