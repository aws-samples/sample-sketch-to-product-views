import { MAX_ATTEMPT_BUDGET, type GenerationSettings } from '@sketch-to-product-views/contracts';

/** One option of a registry param, as `GET /api/models` returns it. */
export interface ParamOption {
  value: string;
  label?: string;
}

export interface ModelParam {
  key: string;
  label?: string;
  default?: unknown;
  options?: ParamOption[];
}

/** What a run that sets nothing gets, from `GET /api/models`. */
export interface DeploymentDefaults {
  size?: string;
  quality?: string;
  attemptBudget: number;
}

export const SETTING_KEYS = ['size', 'quality', 'complexity'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export interface SettingChoice {
  key: SettingKey;
  label: string;
  options: ParamOption[];
  /** What the run gets if this setting is left alone. */
  defaultValue: string;
}

const LABELS: Record<SettingKey, string> = {
  size: 'Image size',
  quality: 'Quality',
  complexity: 'Complexity',
};

/** The settings the model offers, each with the value a run gets by default. */
export function settingChoices(
  params: readonly ModelParam[] | undefined,
  deployment: DeploymentDefaults | undefined,
): SettingChoice[] {
  return SETTING_KEYS.flatMap((key) => {
    const param = params?.find((p) => p.key === key);
    const options = param?.options ?? [];
    if (options.length === 0) return [];
    const offered = (v: unknown): v is string =>
      typeof v === 'string' && options.some((o) => o.value === v);
    const fromDeployment = key === 'complexity' ? undefined : deployment?.[key];
    const defaultValue = offered(fromDeployment)
      ? fromDeployment
      : offered(param?.default)
        ? param.default
        : options[0].value;
    return [{ key, label: param?.label ?? LABELS[key], options, defaultValue }];
  });
}

/** Only what differs from the defaults, so a run with no changes records no settings. */
export function settingsToSend(
  choices: readonly SettingChoice[],
  chosen: Partial<Record<SettingKey, string>>,
  attempts: number,
  defaultAttempts: number,
): GenerationSettings | undefined {
  const settings: GenerationSettings = {};
  for (const choice of choices) {
    const value = chosen[choice.key];
    if (value && value !== choice.defaultValue) settings[choice.key] = value;
  }
  if (attempts !== defaultAttempts) settings.attemptBudget = attempts;
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/** 1 to the most a run may ask for. */
export const ATTEMPT_CHOICES = Array.from({ length: MAX_ATTEMPT_BUDGET }, (_, i) => i + 1);
