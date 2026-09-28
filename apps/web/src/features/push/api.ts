import type { NotifyOn, PushRelayStatus } from "@telar/engine-client";
import { request } from "@/platform/engine/transport";

export const pushRelayStatus = () => request<PushRelayStatus>(fetch, "GET", "/api/mobile/relay");

export const pushNotifyOn = () => request<{ notifyOn: NotifyOn }>(fetch, "GET", "/api/mobile/notify");

export const setPushNotifyOn = (notifyOn: NotifyOn) => request<{ notifyOn: NotifyOn }>(fetch, "PUT", "/api/mobile/notify", { notifyOn });
