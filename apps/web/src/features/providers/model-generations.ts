import type { ProviderModel } from "@telar/engine-client";

export function modelVersion(id: string): number | undefined {
  const match = /(\d+)(?:[.-](\d+))?/.exec(id);
  if (!match) return undefined;
  const major = Number(match[1]);
  if (!Number.isFinite(major)) return undefined;
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  return Number.isFinite(minor) ? major + minor / 100 : major;
}

export type ModelGenerations<T> = {
  current: T[];
  legacy: T[];
};

type Generational = { id: string; isDefault: boolean; hidden: boolean; legacy?: boolean };

export function splitGenerations<T extends Generational>(models: readonly T[]): ModelGenerations<T> {
  const visible = models.filter((model) => !model.hidden);
  const hidden = models.filter((model) => model.hidden);

  if (models.some((model) => model.legacy)) {
    return { current: visible.filter((model) => !model.legacy), legacy: [...hidden, ...visible.filter((model) => model.legacy)] };
  }
  const defaultModel = visible.find((model) => model.isDefault);
  const line = defaultModel ? modelVersion(defaultModel.id) : undefined;

  if (line === undefined) return { current: visible, legacy: hidden };

  const versions = visible.map((model) => modelVersion(model.id)).filter((version): version is number => version !== undefined);
  const previousLine = Math.max(...versions.filter((version) => version < line), Number.NEGATIVE_INFINITY);

  const current: T[] = [];
  const legacy: T[] = [...hidden];
  for (const model of visible) {
    const version = modelVersion(model.id);
    if (version === undefined || version >= (previousLine === Number.NEGATIVE_INFINITY ? line : previousLine)) current.push(model);
    else legacy.push(model);
  }
  return { current, legacy };
}

export function defaultModelId(models: readonly ProviderModel[]): string | undefined {
  return (models.find((model) => model.isDefault) ?? models.find((model) => !model.hidden))?.id;
}

