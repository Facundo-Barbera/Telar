export type DeviceRole = "full" | "observer";
export type DevicePlatform = "ios" | "browser";
export type ExposureMode = "local-only" | "network-accessible";

export type DeviceIdentity = { kind: string; client?: string; machine?: string; os?: string; address?: string; origin?: string };

export type RemoteDevice = {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt?: number;
  role: DeviceRole;
  platform?: DevicePlatform;
  identity?: DeviceIdentity;
};

export type RemoteState = {
  requireAuth: boolean;
  exposure: ExposureMode;
  tailscaleServe: boolean;
  devices: RemoteDevice[];
  pairing?: { expiresAt: number };
};

export type PairingRefusal = "none-pending" | "expired" | "mismatch" | "burned";
