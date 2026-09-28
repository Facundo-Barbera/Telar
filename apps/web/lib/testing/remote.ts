import { createRemoteStore } from "../../../engine/src/domains/remote";
import { remoteHome } from "@/lib/remote/store";

export { hashToken, mintDeviceToken } from "../../../engine/src/domains/remote/store";

const store = () => createRemoteStore(remoteHome());

export const addDevice = (...args: Parameters<ReturnType<typeof createRemoteStore>["addDevice"]>) => store().addDevice(...args);
export const setDeviceRole = (...args: Parameters<ReturnType<typeof createRemoteStore>["setDeviceRole"]>) => store().setDeviceRole(...args);
export const revokeDevice = (id: string) => store().revokeDevice(id);
export const setRequireAuth = (requireAuth: boolean) => store().setRequireAuth(requireAuth);
