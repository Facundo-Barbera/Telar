"use client";

import { useCallback, useEffect, useState } from "react";
import type { ComputerUseGrant, ComputerUseStatus } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";

const api = createEngineApi();

export function grantFollowUp(opened: ComputerUseGrant["opened"], status: ComputerUseStatus | undefined): "done" | "next-pane" | "wait" {
  if (status?.permission === "granted") return "done";
  if (opened === "accessibility" && status?.missing?.length === 1 && status.missing[0] === "screen-recording") return "next-pane";
  return "wait";
}

export const GRANT_POLL_MS = 3_000;
export const GRANT_WAIT_MS = 10 * 60_000;

export function useComputerUse() {
  const [status, setStatus] = useState<ComputerUseStatus>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();

  const check = useCallback(async () => {
    setChecking(true);
    setError(undefined);
    try {
      setStatus((await api.computerUseStatus()).computerUse);
    } catch {
      setError("The engine did not answer.");
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void check(), 0);
    return () => window.clearTimeout(task);
  }, [check]);

  const poll = useCallback(async () => {
    try {
      const next = (await api.computerUseStatus()).computerUse;
      setStatus(next);
      return next;
    } catch {
      return undefined;
    }
  }, []);

  const [waiting, setWaiting] = useState<ComputerUseGrant["opened"] | "none">();
  const [granting, setGranting] = useState(false);

  const grant = async () => {
    setGranting(true);
    setError(undefined);
    try {
      const answer = await api.grantComputerUseAccess();
      if (answer.message) setError(answer.message);
      if (!answer.started) return;
      setWaiting(answer.opened ?? "none");
    } catch {
      setError("The engine did not answer.");
    } finally {
      setGranting(false);
    }
  };

  useEffect(() => {
    if (waiting === undefined) return;
    let asked = false;
    const tick = async () => {
      const step = grantFollowUp(waiting === "none" ? undefined : waiting, await poll());
      if (step === "done") setWaiting(undefined);
      if (step === "next-pane" && !asked) {
        asked = true;
        const answer = await api.grantComputerUseAccess().catch(() => undefined);
        if (answer?.message) setError(answer.message);
        if (answer?.opened) setWaiting(answer.opened);
      }
    };
    const timer = window.setInterval(() => void tick(), GRANT_POLL_MS);
    const stop = window.setTimeout(() => setWaiting(undefined), GRANT_WAIT_MS);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(stop);
      window.removeEventListener("focus", tick);
    };
  }, [waiting, poll]);

  const reveal = async () => {
    try {
      if (!(await api.revealComputerUseHelper()).revealed) setError("Finder did not open.");
    } catch {
      setError("The engine did not answer.");
    }
  };

  const remove = async () => {
    try {
      const answer = await api.resetComputerUseAccess();
      await check();
      if (!answer.reset && answer.message) setError(answer.message);
    } catch {
      setError("The engine did not answer.");
    }
  };

  return { status, checking, granting, error, check, grant, reveal, remove };
}
