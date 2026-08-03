"use client";

// The composer exposes three focused decisions instead of one miniature
// settings page: agent/model, reasoning, and permissions. Provider and account
// live inside the agent picker because together they identify the runtime that
// owns the selected model. Each menu is sized for one question and applies its
// choice immediately.

import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  GaugeIcon,
  SearchIcon,
  ShieldCheckIcon,
  StarIcon,
  UserRoundIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { cachedJson } from "@/lib/client-json-cache";
import { DEFAULT_MODEL, modelsForProvider, type ModelInfo } from "@/lib/models";
import { getUiPrefs } from "@/lib/ui-prefs";
import { ProviderIcon, PROVIDER_LABEL } from "@/components/session/provider-icon";
import {
  triggerLabel,
  type ProviderOptionGroup,
} from "@/lib/provider-options";

type Provider = "claude" | "codex";

export type ComposerAccountOption = {
  name: string;
  provider?: Provider;
  displayTier?: string;
};

export type ApprovalOption = {
  value: string;
  label: string;
  description: string;
};

export type ApprovalConfig = {
  title: string;
  value: string;
  options: readonly ApprovalOption[];
  onChange: (value: string) => void;
  defaultValue: string;
  seedValue?: () => string | undefined;
};

function controlClass(open: boolean) {
  return cn(
    "flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-input bg-transparent px-2.5 text-xs font-medium text-muted-foreground transition-colors",
    "hover:bg-accent hover:text-foreground",
    open && "border-ring bg-accent text-foreground",
  );
}

type ControlTriggerProps = ComponentPropsWithoutRef<"button"> & {
  open: boolean;
  icon: ReactNode;
  label: string;
  detail?: string;
  ariaLabel: string;
};

const ControlTrigger = forwardRef<HTMLButtonElement, ControlTriggerProps>(
  ({ open, icon, label, detail, ariaLabel, className, ...props }, ref) => (
    <button
      {...props}
      ref={ref}
      type="button"
      className={cn(controlClass(open), className)}
      aria-label={ariaLabel}
    >
      {icon}
      <span className="max-w-32 truncate text-foreground">{label}</span>
      {detail ? (
        <>
          <span className="hidden text-muted-foreground/40 md:inline">·</span>
          <span className="hidden max-w-24 truncate md:inline">{detail}</span>
        </>
      ) : null}
      <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
    </button>
  ),
);
ControlTrigger.displayName = "ControlTrigger";

function MenuHeading({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

function ModelRow({
  model,
  selected,
  favorite,
  disabled,
  onSelect,
  onToggleFavorite,
}: {
  model: ModelInfo;
  selected: boolean;
  favorite: boolean;
  disabled: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex w-full items-center rounded-lg transition-colors",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left disabled:cursor-default"
      >
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-full border",
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-input",
          )}
        >
          {selected ? <CheckIcon className="size-3" /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{model.name}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {PROVIDER_LABEL[model.provider ?? "claude"]}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onToggleFavorite}
        aria-label={`${favorite ? "Remove" : "Add"} ${model.name} ${favorite ? "from" : "to"} favorites`}
        className="mr-1.5 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground"
      >
        <StarIcon className={cn("size-3.5", favorite && "fill-current text-amber-500")} />
      </button>
    </div>
  );
}

function ChoiceRow({
  label,
  description,
  selected,
  onSelect,
}: {
  label: string;
  description?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {selected ? <CheckIcon className="size-3.5 text-primary" /> : null}
      </span>
    </button>
  );
}

const modelFamilyKey = (option: Pick<ModelInfo, "id" | "resolvedModel">) =>
  (option.resolvedModel ?? option.id)
    .replace(/\[1m\]$/i, "")
    .replace(/-\d{8}$/i, "");

const FAVORITE_MODELS_KEY = "telar:favorite-models";

const providerForModel = (model: ModelInfo): Provider => model.provider ?? "claude";

const favoriteModelKey = (model: ModelInfo): string =>
  `${providerForModel(model)}:${modelFamilyKey(model)}`;

export function ComposerControls({
  project,
  provider,
  providers,
  onProviderChange,
  account,
  accounts,
  onAccountChange,
  runtimeLocked,
  model,
  setModel,
  optionGroups,
  optionValues,
  onOptionChange,
  approval,
  modelOptions,
}: {
  project: string;
  provider: Provider;
  providers: readonly Provider[];
  onProviderChange: (provider: Provider) => void;
  account: string;
  accounts: readonly ComposerAccountOption[];
  onAccountChange: (account: string) => void;
  runtimeLocked: boolean;
  model: string;
  setModel: (model: string) => void;
  optionGroups: readonly ProviderOptionGroup[];
  optionValues: Readonly<Record<string, string>>;
  onOptionChange: (group: string, value: string) => void;
  approval: ApprovalConfig;
  modelOptions: ModelInfo[];
}) {
  const [agentOpen, setAgentOpen] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [modelView, setModelView] = useState<Provider | "favorites">(provider);
  const [catalogs, setCatalogs] = useState<Partial<Record<Provider, ModelInfo[]>>>({});
  const [favoriteModels, setFavoriteModels] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const saved = JSON.parse(window.localStorage.getItem(FAVORITE_MODELS_KEY) ?? "[]");
      return Array.isArray(saved)
        ? new Set(saved.filter((value): value is string => typeof value === "string"))
        : new Set();
    } catch {
      // Corrupt preferences degrade to an empty favorites list.
      return new Set();
    }
  });

  useEffect(() => {
    if (!agentOpen) return;
    let cancelled = false;
    const requests = providers.map(async (catalogProvider) => {
      if (catalogProvider === provider) return [catalogProvider, modelOptions] as const;
      const catalogAccount = accounts.find(
        (candidate) => (candidate.provider ?? "claude") === catalogProvider,
      );
      if (!catalogAccount) {
        return [catalogProvider, modelsForProvider(catalogProvider)] as const;
      }
      const params = new URLSearchParams({
        provider: catalogProvider,
        account: catalogAccount.name,
        project,
      });
      try {
        const data = await cachedJson<{ models?: ModelInfo[] }>(
          `/api/models?${params.toString()}`,
          { maxAgeMs: 60 * 60 * 1000 },
        );
        const models = Array.isArray(data.models) && data.models.length > 0
          ? data.models
          : modelsForProvider(catalogProvider);
        return [catalogProvider, models] as const;
      } catch {
        return [catalogProvider, modelsForProvider(catalogProvider)] as const;
      }
    });
    void Promise.all(requests).then((entries) => {
      if (cancelled) return;
      setCatalogs((current) => ({ ...current, ...Object.fromEntries(entries) }));
    });
    return () => {
      cancelled = true;
    };
  }, [accounts, agentOpen, modelOptions, project, provider, providers]);

  // Seed untouched new sessions from the global Claude defaults. Per-project
  // composer memory and explicit choices still win, matching the old combined
  // control's behavior without coupling persistence to any popover's lifetime.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    if (typeof window === "undefined") return;
    try {
      if (window.localStorage.getItem(`telar:composer:${project}`)) return;
    } catch {
      return;
    }
    const preferences = getUiPrefs();
    if (
      model === DEFAULT_MODEL &&
      modelsForProvider("claude").some(
        (option) => option.id === preferences.defaultModel,
      )
    ) {
      setModel(preferences.defaultModel);
      const seed = approval.seedValue?.();
      if (seed && approval.value === approval.defaultValue) {
        approval.onChange(seed);
      }
    }
    // Seed only once for this mount. Reacting to later model/approval changes
    // would overwrite deliberate composer choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  const activeModel = modelOptions.find((option) => option.id === model);
  const modelLabel = activeModel?.name ?? model;
  const reasoningLabel = triggerLabel(optionGroups, optionValues) ?? "Reasoning";
  const activeApproval = approval.options.find(
    (option) => option.value === approval.value,
  );
  const approvalLabel = activeApproval?.label ?? approval.options[0]?.label ?? "";
  const providerAccounts = accounts.filter(
    (option) => (option.provider ?? "claude") === provider,
  );
  const hasModelQuery = modelQuery.trim().length > 0;
  const toggleFavorite = (option: ModelInfo) => {
    setFavoriteModels((current) => {
      const next = new Set(current);
      const key = favoriteModelKey(option);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        window.localStorage.setItem(FAVORITE_MODELS_KEY, JSON.stringify([...next]));
      } catch {
        // The in-memory choice remains useful when storage is unavailable.
      }
      return next;
    });
  };
  const visibleModels = useMemo(() => {
    const families = new Map<string, ModelInfo>();
    const preference = (option: ModelInfo, key: string) =>
      (`${providerForModel(option)}:${modelFamilyKey({ id: option.id })}` === key ? 4 : 0) +
      (option.id === model ? 2 : 0) +
      (option.isDefault ? 1 : 0);
    const allModels = providers.flatMap((catalogProvider) =>
      catalogProvider === provider
        ? modelOptions
        : catalogs[catalogProvider] ?? modelsForProvider(catalogProvider),
    );
    for (const option of allModels) {
      const key = favoriteModelKey(option);
      const existing = families.get(key);
      if (!existing || preference(option, key) > preference(existing, key)) {
        families.set(key, option);
      }
    }
    const models = [...families.values()];
    const query = modelQuery.trim().toLowerCase();
    if (query) {
      return models.filter((option) =>
          `${option.name} ${option.id} ${option.tier}`
            .toLowerCase()
            .includes(query),
        );
    }
    return modelView === "favorites"
      ? models.filter((option) => favoriteModels.has(favoriteModelKey(option)))
      : models.filter((option) => providerForModel(option) === modelView);
  }, [catalogs, favoriteModels, model, modelOptions, modelQuery, modelView, provider, providers]);

  const activeFamily =
    activeModel ? modelFamilyKey(activeModel) : modelFamilyKey({ id: model });

  const changeAgentOpen = (next: boolean) => {
    setAgentOpen(next);
    setModelQuery("");
    setModelView(provider);
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Popover open={agentOpen} onOpenChange={changeAgentOpen}>
        <PopoverTrigger
          render={
            <ControlTrigger
              open={agentOpen}
              icon={<ProviderIcon provider={provider} size={14} />}
              label={modelLabel}
              detail={providerAccounts.length > 1 ? account : undefined}
              ariaLabel={`Agent: ${PROVIDER_LABEL[provider]}, ${modelLabel}, account ${account}`}
              className="w-40 justify-start"
            />
          }
        />
        <PopoverContent
          align="start"
          side="top"
          sideOffset={8}
          className="flex h-[min(340px,calc(100vh-5rem))] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden p-0"
        >
          <div className="flex min-h-0 flex-1">
            <div className="flex w-14 shrink-0 flex-col items-center gap-1 border-r bg-muted/20 p-2">
              <button
                type="button"
                onClick={() => {
                  setModelQuery("");
                  setModelView("favorites");
                }}
                aria-label="Favorites"
                title="Favorites"
                className={cn(
                  "flex size-9 items-center justify-center rounded-lg transition-colors",
                  modelView === "favorites"
                    ? "bg-accent text-foreground shadow-sm ring-1 ring-border"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <StarIcon className="size-4" />
              </button>
              {providers.map((option) => (
                <button
                  key={option}
                  type="button"
                  disabled={runtimeLocked}
                  onClick={() => {
                    setModelQuery("");
                    setModelView(option);
                    onProviderChange(option);
                  }}
                  aria-label={PROVIDER_LABEL[option]}
                  title={PROVIDER_LABEL[option]}
                  className={cn(
                    "flex size-9 items-center justify-center rounded-lg transition-colors disabled:cursor-default",
                    modelView === option
                      ? "bg-accent text-foreground shadow-sm ring-1 ring-border"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <ProviderIcon provider={option} size={18} />
                </button>
              ))}
            </div>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-3">
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={modelQuery}
                  onChange={(event) => setModelQuery(event.target.value)}
                  placeholder="Search all models"
                  aria-label="Search models"
                  className="h-9 pl-8 text-xs"
                />
              </div>

              {!hasModelQuery && modelView === provider && providerAccounts.length > 1 ? (
                <div className="space-y-1.5">
                  <MenuHeading>Account</MenuHeading>
                  <div className="flex flex-wrap gap-1">
                    {providerAccounts.map((option) => (
                      <button
                        key={option.name}
                        type="button"
                        disabled={runtimeLocked}
                        onClick={() => onAccountChange(option.name)}
                        className={cn(
                          "flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors disabled:cursor-default",
                          account === option.name
                            ? "border-ring bg-accent text-foreground"
                            : "border-input text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                        )}
                      >
                        <UserRoundIcon className="size-3 shrink-0" />
                        <span className="max-w-40 truncate">{option.name}</span>
                        {option.displayTier ? (
                          <span className="rounded border border-border px-1 text-[9px] text-muted-foreground">
                            {option.displayTier}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="flex min-h-0 flex-1 flex-col gap-1.5">
                <MenuHeading>
                  {hasModelQuery
                    ? "Search results"
                    : modelView === "favorites"
                      ? "Favorites"
                      : `${PROVIDER_LABEL[modelView]} models`}
                </MenuHeading>
                <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
                  {visibleModels.map((option) => (
                    <ModelRow
                      key={favoriteModelKey(option)}
                      model={option}
                      selected={
                        providerForModel(option) === provider &&
                        modelFamilyKey(option) === activeFamily
                      }
                      favorite={favoriteModels.has(favoriteModelKey(option))}
                      disabled={runtimeLocked}
                      onSelect={() => {
                        const nextProvider = providerForModel(option);
                        if (nextProvider !== provider) onProviderChange(nextProvider);
                        setModel(option.id);
                        changeAgentOpen(false);
                      }}
                      onToggleFavorite={() => toggleFavorite(option)}
                    />
                  ))}
                  {visibleModels.length === 0 ? (
                    <p className="px-2.5 py-5 text-center text-xs text-muted-foreground">
                      {modelView === "favorites" && !hasModelQuery
                        ? "Star a model to keep it here."
                        : `No models match “${modelQuery}”.`}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <Popover open={reasoningOpen} onOpenChange={setReasoningOpen}>
        <PopoverTrigger
          render={
            <ControlTrigger
              open={reasoningOpen}
              icon={<GaugeIcon className="size-3.5" />}
              label={reasoningLabel}
              ariaLabel={`Model options: ${reasoningLabel}`}
            />
          }
        />
        <PopoverContent align="start" sideOffset={8} className="w-72 p-1.5">
          {optionGroups.map((group, index) => (
            <div key={group.id} className={cn(index > 0 && "mt-1 border-t pt-1")}>
              <MenuHeading>{group.label}</MenuHeading>
              {group.values.map((option) => (
                <ChoiceRow
                  key={option.value}
                  label={option.label}
                  description={option.blurb}
                  selected={optionValues[group.id] === option.value}
                  onSelect={() => onOptionChange(group.id, option.value)}
                />
              ))}
            </div>
          ))}
        </PopoverContent>
      </Popover>

      <Popover open={approvalOpen} onOpenChange={setApprovalOpen}>
        <PopoverTrigger
          render={
            <ControlTrigger
              open={approvalOpen}
              icon={<ShieldCheckIcon className="size-3.5" />}
              label={approvalLabel}
              ariaLabel={`${approval.title}: ${approvalLabel}`}
            />
          }
        />
        <PopoverContent
          align="start"
          sideOffset={8}
          className="w-[min(300px,calc(100vw-2rem))] p-1.5"
        >
          <MenuHeading>{approval.title}</MenuHeading>
          {approval.options.map((option) => (
            <ChoiceRow
              key={option.value}
              label={option.label}
              description={option.description}
              selected={approval.value === option.value}
              onSelect={() => {
                approval.onChange(option.value);
                setApprovalOpen(false);
              }}
            />
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}
