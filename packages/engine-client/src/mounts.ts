export function mountRootsFor(platform: NodeJS.Platform): string[] {
  return platform === "darwin" ? ["/Volumes"] : platform === "linux" ? ["/media", "/mnt"] : [];
}

export type VolumeSupport = "identified" | "located" | "unsupported";
export function volumeSupportOn(platform: NodeJS.Platform): VolumeSupport {
  if (mountRootsFor(platform).length === 0) return "unsupported";
  return platform === "darwin" ? "identified" : "located";
}
