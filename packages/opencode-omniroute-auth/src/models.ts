import type {
  OmniRouteConfig,
  OmniRouteModel,
  OmniRouteModelListConfig,
  OmniRouteModelVariant,
  OmniRouteModelsResponse,
} from './types.js';
import {
  OMNIROUTE_DEFAULT_MODELS,
  OMNIROUTE_ENDPOINTS,
  MODEL_CACHE_TTL,
  REQUEST_TIMEOUT,
  PROVIDER_ALIAS_TO_CANONICAL,
} from './constants.js';
import {
  getModelsDevIndex,
  normalizeModelKey,
  getSubscriptionFallback,
  stripVariantSuffix,
  resolveProviderAlias,
  resolveModelAlias,
} from './models-dev.js';
import type { ModelsDevIndex, ModelsDevModel } from './models-dev.js';
import { enrichComboModels, clearComboCache, splitModelId } from './omniroute-combos.js';
import { warn, debug } from './logger.js';

function sanitizeForLog(value: string): string {
  return [...value]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 0x09 || (code >= 0x20 && code !== 0x7f);
    })
    .join('');
}

/**
 * Model cache entry
 */
interface ModelCache {
  models: OmniRouteModel[];
  timestamp: number;
}

/**
 * In-memory model cache keyed by endpoint and API key
 */
const modelCache = new Map<string, ModelCache>();
const MODEL_NAME_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});
const SYNTHETIC_OPENAI_COMPATIBLE_MODEL =
  /^openai-compatible-(chat|responses)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Generate a cache key for a given configuration
 */
function getCacheKey(config: OmniRouteConfig, apiKey: string): string {
  const baseUrl = config.baseUrl || OMNIROUTE_ENDPOINTS.BASE_URL;

  // Include modelsDev config in cache key to prevent stale data
  const modelsDevHash = config.modelsDev
    ? JSON.stringify({
        enabled: config.modelsDev.enabled,
        url: config.modelsDev.url,
        providerAliases: config.modelsDev.providerAliases,
      })
    : '';

  const modelListHash = config.modelList
    ? JSON.stringify({
        dedupe: config.modelList.dedupe,
        cleanNames: config.modelList.cleanNames,
        include: serializeMatchersForCache(config.modelList.include),
        exclude: serializeMatchersForCache(config.modelList.exclude),
        aliases: config.modelList.aliases,
        rename: config.modelList.rename,
        sort: config.modelList.sort,
      })
    : '';

  return `${baseUrl}:${apiKey}:${modelsDevHash}:${modelListHash}`;
}

function serializeMatchersForCache(matchers: Array<string | RegExp> | undefined): unknown[] | undefined {
  return matchers?.map((matcher) =>
    typeof matcher === 'string'
      ? matcher
      : { source: matcher.source, flags: matcher.flags },
  );
}

/**
 * Normalize an OmniRoute model by reading all field variants
 * with proper precedence: camelCase > snake_case > capabilities
 */
function normalizeModel(model: OmniRouteModel): OmniRouteModel {
  const capabilities =
    model.capabilities && typeof model.capabilities === 'object'
      ? model.capabilities
      : {};

  return {
    ...model,
    id: model.id,
    name: model.name || model.id,
    description: model.description || `OmniRoute model: ${model.id}`,

    // Context limits: prefer explicit camelCase, fallback to snake_case
    contextWindow:
      model.contextWindow ?? model.context_length ?? model.max_input_tokens,
    maxTokens: model.maxTokens ?? model.max_output_tokens,

    // Capabilities: prefer explicit camelCase, fallback to capabilities object, fallback to snake_case
    supportsStreaming: model.supportsStreaming,
    supportsVision:
      model.supportsVision ??
      model.vision ??
      capabilities.vision ??
      capabilities.attachment,
    supportsTools:
      model.supportsTools ??
      model.tool_calling ??
      capabilities.tool_calling ??
      capabilities.toolcall,
    supportsReasoning:
      model.supportsReasoning ??
      model.reasoning ??
      capabilities.reasoning ??
      capabilities.thinking,
    supportsAttachment:
      model.supportsAttachment ??
      model.attachment ??
      capabilities.attachment,
    supportsTemperature:
      model.supportsTemperature ??
      model.temperature ??
      capabilities.temperature,
  };
}

function isSyntheticOpenAICompatibleModel(model: OmniRouteModel): boolean {
  return (
    SYNTHETIC_OPENAI_COMPATIBLE_MODEL.test(model.id) ||
    SYNTHETIC_OPENAI_COMPATIBLE_MODEL.test(model.name)
  );
}

function getProviderAliasDedupeId(model: OmniRouteModel): string {
  const parts = model.id.split('/');
  if (parts.length !== 2) {
    return model.id;
  }

  const [providerPrefix, modelKey] = parts;
  const canonicalPrefix = PROVIDER_ALIAS_TO_CANONICAL[providerPrefix];
  if (!canonicalPrefix) {
    return model.id;
  }

  return `${canonicalPrefix}/${modelKey}`;
}

function getRootDedupeKey(model: OmniRouteModel): string | null {
  if (!model.owned_by || !model.root) {
    return null;
  }

  return `${model.owned_by}:${model.root}`;
}

function getModelPriority(model: OmniRouteModel): number {
  let score = 0;

  if (model.parent === null || model.parent === undefined) {
    score += 4;
  }

  if (getProviderAliasDedupeId(model) === model.id) {
    score += 2;
  }

  if (model.name && model.name !== model.id) {
    score += 1;
  }

  return score;
}

function mergeDuplicateModels(primary: OmniRouteModel, secondary: OmniRouteModel): OmniRouteModel {
  return {
    ...secondary,
    ...primary,
    id: primary.id,
    name: primary.name || secondary.name,
    parent: primary.parent ?? secondary.parent ?? null,
  };
}

/**
 * Deduplicate models by primary root entry first, then provider alias.
 *
 * Root-based dedupe keeps the primary model (`parent: null`) when OmniRoute
 * returns both the primary id and an alias entry for the same `owned_by/root`.
 * Provider-alias dedupe then normalizes known aliases like `ollamacloud`.
 */
function deduplicateModels(models: OmniRouteModel[]): OmniRouteModel[] {
  const byRoot = new Map<string, OmniRouteModel>();
  const withoutRoot: OmniRouteModel[] = [];

  for (const model of models) {
    const rootKey = getRootDedupeKey(model);
    if (!rootKey) {
      withoutRoot.push(model);
      continue;
    }

    const existing = byRoot.get(rootKey);
    if (!existing) {
      byRoot.set(rootKey, model);
      continue;
    }

    const primary = getModelPriority(model) > getModelPriority(existing) ? model : existing;
    const secondary = primary === model ? existing : model;
    byRoot.set(rootKey, mergeDuplicateModels(primary, secondary));
  }

  const seen = new Map<string, OmniRouteModel>();

  for (const model of [...byRoot.values(), ...withoutRoot]) {
    const canonicalId = getProviderAliasDedupeId(model);

    const existing = seen.get(canonicalId);
    if (!existing) {
      seen.set(canonicalId, model);
    } else {
      const primary = getModelPriority(model) > getModelPriority(existing) ? model : existing;
      const secondary = primary === model ? existing : model;
      seen.set(canonicalId, mergeDuplicateModels(primary, secondary));
    }
  }

  return [...seen.values()].map((model) => ({
    ...model,
    id: getProviderAliasDedupeId(model),
  }));
}

const DISPLAY_LABEL_OVERRIDES: Record<string, string> = {
  'command-code': 'Command Code',
  glm: 'GLM',
  kimi: 'Kimi',
  mimo: 'MiMo',
  moonshotai: 'MoonshotAI',
  openrouter: 'Openrouter',
  'umans-ai-coding-plan': 'Umans AI Coding Plan',
  'xiaomi-mimo': 'Xiaomi Mimo',
  'z-ai': 'Z-AI',
};

function getDisplayAliases(config: OmniRouteModelListConfig | undefined): Record<string, string> {
  const aliases = { ...DISPLAY_LABEL_OVERRIDES };
  for (const [key, value] of Object.entries(config?.aliases ?? {})) {
    aliases[key.toLowerCase()] = value;
  }
  return aliases;
}

function formatDisplaySegment(segment: string, aliases: Record<string, string>): string {
  const override = aliases[segment.toLowerCase()];
  if (override) {
    return override;
  }

  return segment
    .split('-')
    .map((part) => {
      const partOverride = aliases[part.toLowerCase()];
      if (partOverride) {
        return partOverride;
      }

      if (/^[a-z]/i.test(part)) {
        return part.charAt(0).toUpperCase() + part.slice(1);
      }

      return part;
    })
    .join('-');
}

function buildCleanModelName(
  model: OmniRouteModel,
  aliases: Record<string, string>,
): string {
  const idParts = model.id.split('/');
  let providerSource = idParts.length === 2 ? model.owned_by ?? idParts[0] : idParts[0];
  if (providerSource && SYNTHETIC_OPENAI_COMPATIBLE_MODEL.test(providerSource)) {
    providerSource = resolveProviderAlias(idParts[0], undefined) ?? idParts[0];
  }
  const providerName = formatDisplaySegment(providerSource, aliases);

  const modelSource =
    model.name && model.name !== model.id
      ? model.name
      : idParts.length > 1
        ? idParts.slice(1).join('/')
        : model.id;
  const modelName = modelSource
    .split('/')
    .map((segment) => formatDisplaySegment(segment, aliases))
    .join(' ');

  return `${providerName}: ${modelName}`;
}

function matcherMatches(matcher: string | RegExp, values: string[]): boolean {
  if (typeof matcher === 'string') {
    return values.some((value) => value === matcher);
  }

  return values.some((value) => {
    matcher.lastIndex = 0;
    return matcher.test(value);
  });
}

function matchesAny(matchers: Array<string | RegExp>, values: string[]): boolean {
  return matchers.some((matcher) => matcherMatches(matcher, values));
}

function isSlugLikeModelName(name: string): boolean {
  return /^[a-z0-9]+([._/-][a-z0-9]+)+$/.test(name);
}

function summarizeMatchCounts(values: number[]): string {
  return values.join(',');
}

export function applyModelListConfig(
  models: OmniRouteModel[],
  config: OmniRouteModelListConfig | undefined,
): OmniRouteModel[] {
  if (!config) {
    return models;
  }

  const aliases = getDisplayAliases(config);
  const transformed = models.flatMap((model) => {
    const cleanedName = config.cleanNames === true ? buildCleanModelName(model, aliases) : model.name;
    const renamedName = config.rename?.[model.id] ?? cleanedName;
    const matchValues = [model.id, model.name, cleanedName, renamedName];

    if (config.include && !matchesAny(config.include, matchValues)) {
      return [];
    }

    if (config.exclude && matchesAny(config.exclude, matchValues)) {
      return [];
    }

    if (renamedName === model.name) {
      return [model];
    }

    return [{
      ...model,
      name: renamedName,
    }];
  });

  if (config.sort === 'name') {
    transformed.sort((left, right) => MODEL_NAME_COLLATOR.compare(left.name, right.name));
  }

  return transformed;
}

/**
 * Reverse a provider alias to its canonical form for metadata lookups.
 * Returns the original id if no alias mapping exists.
 */
export function resolveProviderAliasForMetadata(modelId: string): string {
  const parts = modelId.split('/');
  if (parts.length !== 2) return modelId;
  
  const [providerPrefix, modelKey] = parts;
  const canonicalPrefix = PROVIDER_ALIAS_TO_CANONICAL[providerPrefix];
  if (!canonicalPrefix) return modelId;
  
  return `${canonicalPrefix}/${modelKey}`;
}

/**
 * Check if a provider prefix is a known alias.
 */
export function isProviderAlias(providerPrefix: string): boolean {
  return providerPrefix in PROVIDER_ALIAS_TO_CANONICAL;
}

/**
 * Group variant-suffixed models (e.g. gpt-5.5-xhigh) under their base model.
 * Returns a new array where every base model with variants gets a `variants` Record.
 */
export function groupVariantModels(models: OmniRouteModel[]): OmniRouteModel[] {
  const realBaseModels = new Map<string, OmniRouteModel>();
  const variantMap = new Map<string, Array<{ suffix: string; model: OmniRouteModel }>>();

  // Pass 1 — Categorize
  for (const model of models) {
    const { base, stripped } = stripVariantSuffix(model.id);
    if (!stripped) {
      realBaseModels.set(model.id, model);
    } else {
      const suffix = model.id.slice(base.length + 1).toLowerCase();
      const entry = variantMap.get(base);
      if (entry) {
        entry.push({ suffix, model });
      } else {
        variantMap.set(base, [{ suffix, model }]);
      }
    }
  }

  const result: OmniRouteModel[] = [];

  // Add all real base models that have no variants (unchanged)
  for (const [id, model] of realBaseModels) {
    if (!variantMap.has(id)) {
      result.push(model);
    }
  }

  // For each base ID that has variants
  for (const [baseId, variants] of variantMap) {
    const baseModel = realBaseModels.get(baseId);

    // Use real base model if available; otherwise create synthetic base from first variant
    const merged: OmniRouteModel = baseModel
      ? { ...baseModel }
      : { ...variants[0].model, id: baseId, name: baseId };

    // Build variants Record
    const variantsRecord: Record<string, OmniRouteModelVariant> = {};
    for (const { suffix } of variants) {
      if (
        suffix === 'low' ||
        suffix === 'medium' ||
        suffix === 'high' ||
        suffix === 'xhigh'
      ) {
        variantsRecord[suffix] = { reasoningEffort: suffix };
      }
    }
    merged.variants = variantsRecord;

    // Merge metadata from all variants into base: use max limits and union capabilities.
    for (const { model } of variants) {
      if (model.contextWindow !== undefined) {
        merged.contextWindow = Math.max(merged.contextWindow ?? 0, model.contextWindow);
      }
      if (model.maxTokens !== undefined) {
        merged.maxTokens = Math.max(merged.maxTokens ?? 0, model.maxTokens);
      }
      if (model.supportsReasoning) {
        merged.supportsReasoning = true;
      }
      if (model.supportsVision) {
        merged.supportsVision = true;
      }
      if (model.supportsTools) {
        merged.supportsTools = true;
      }
      if (model.supportsStreaming) {
        merged.supportsStreaming = true;
      }
      if (model.supportsTemperature) {
        merged.supportsTemperature = true;
      }
      if (model.supportsAttachment) {
        merged.supportsAttachment = true;
      }
    }

    result.push(merged);
  }

  return result;
}

/**
 * Fetch models from OmniRoute /v1/models endpoint
 * This is the CRITICAL FEATURE - dynamically fetches available models
 *
 * @param config - OmniRoute configuration
 * @param apiKey - API key for authentication
 * @returns Array of available models
 */
export async function fetchModels(
  config: OmniRouteConfig,
  apiKey: string,
  forceRefresh: boolean = false,
): Promise<OmniRouteModel[]> {
  const cacheKey = getCacheKey(config, apiKey);

  // Check cache first if not forcing refresh
  if (!forceRefresh) {
    // Validate TTL is positive to prevent unexpected cache behavior
    const cacheTtl =
      config.modelCacheTtl && config.modelCacheTtl > 0 ? config.modelCacheTtl : MODEL_CACHE_TTL;

    const cached = modelCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < cacheTtl) {
      debug('Using cached models');
      return cached.models;
    }
  } else {
    debug('Forcing model refresh');
  }

  // Use default baseUrl if not provided to prevent undefined URL
  const baseUrl = config.baseUrl || OMNIROUTE_ENDPOINTS.BASE_URL;
  const modelsUrl = `${baseUrl}${OMNIROUTE_ENDPOINTS.MODELS}`;

  debug(`Fetching models from ${modelsUrl}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(modelsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      // Sanitize error - only log status, not response body
      warn(`Failed to fetch models: ${response.status} ${response.statusText}`);
      throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
    }

    // Parse and validate response structure before type casting
    const rawData = await response.json();

    // Runtime validation to ensure API returns expected structure
    if (!rawData || typeof rawData !== 'object' || !Array.isArray(rawData.data)) {
      const dataType = rawData && typeof rawData === 'object'
        ? (rawData.data === null
            ? 'null'
            : Array.isArray(rawData.data) ? 'array' : typeof rawData.data)
        : typeof rawData;
      warn(`Invalid models response structure: expected { data: Array }, got { data: ${dataType} }`);
      throw new Error('Invalid models response structure: expected { data: Array }');
    }

    const data = rawData as OmniRouteModelsResponse;

    // Transform and validate models - filter out invalid entries
    const rawModels = data.data
      .filter(
        (model): model is OmniRouteModel =>
          model !== null && model !== undefined && typeof model.id === 'string',
      )
      .map(normalizeModel)
      .filter((model) => !isSyntheticOpenAICompatibleModel(model));

    const dedupedModels = config.modelList?.dedupe === false ? rawModels : deduplicateModels(rawModels);
    const groupedModels = groupVariantModels(dedupedModels);
    const enrichedModels = await enrichModelMetadata(groupedModels, config);
    const models = applyModelListConfig(enrichedModels, config.modelList);

    debug(
      `Model list transformed: fetched=${rawModels.length}, deduped=${dedupedModels.length}, grouped=${groupedModels.length}, enriched=${enrichedModels.length}, emitted=${models.length}`,
    );

    // Update cache
    modelCache.set(cacheKey, {
      models,
      timestamp: Date.now(),
    });

    debug(`Successfully fetched ${models.length} models`);
    return models;
  } catch (error) {
    warn(`Error fetching models: ${error}`);

    // Return cached models if available (even if expired)
    const cached = modelCache.get(cacheKey);
    if (cached) {
      debug('Returning expired cached models as fallback');
      return cached.models;
    }

    // Return default models as last resort
    debug('Returning default models as fallback');
    return applyModelListConfig(config.defaultModels || OMNIROUTE_DEFAULT_MODELS, config.modelList);
  } finally {
    // Always clear the timeout to prevent memory leaks
    clearTimeout(timeoutId);
  }
}

/**
 * Clear the model cache
 * @param config - Optional OmniRoute configuration to clear specific cache
 * @param apiKey - Optional API key to clear specific cache
 */
export function clearModelCache(config?: OmniRouteConfig, apiKey?: string): void {
  if (config && apiKey) {
    const cacheKey = getCacheKey(config, apiKey);
    modelCache.delete(cacheKey);
    debug('Model cache cleared for provided configuration');
  } else {
    modelCache.clear();
    debug('All model caches cleared');
  }
  // Also clear combo cache
  clearComboCache();
}

/**
 * Get cached models without fetching
 * @param config - OmniRoute configuration
 * @param apiKey - API key for authentication
 * @returns Cached models or null
 */
export function getCachedModels(config: OmniRouteConfig, apiKey: string): OmniRouteModel[] | null {
  const cacheKey = getCacheKey(config, apiKey);
  return modelCache.get(cacheKey)?.models || null;
}

/**
 * Check if cache is valid
 * @param config - OmniRoute configuration
 * @param apiKey - API key for authentication
 * @returns True if cache is valid
 */
export function isCacheValid(config: OmniRouteConfig, apiKey: string): boolean {
  const cacheKey = getCacheKey(config, apiKey);
  const cached = modelCache.get(cacheKey);
  if (!cached) return false;
  const ttl = config.modelCacheTtl || MODEL_CACHE_TTL;
  return Date.now() - cached.timestamp < ttl;
}

/**
 * Force refresh models from API
 * @param config - OmniRoute configuration
 * @param apiKey - API key for authentication
 * @returns Array of available models
 */
export async function refreshModels(
  config: OmniRouteConfig,
  apiKey: string,
): Promise<OmniRouteModel[]> {
  clearModelCache();
  return fetchModels(config, apiKey, true);
}

/**
 * Enrich model metadata with models.dev data and combo capabilities
 */
async function enrichModelMetadata(
  models: OmniRouteModel[],
  config: OmniRouteConfig,
): Promise<OmniRouteModel[]> {
  const modelsDevIndex = await getModelsDevIndex(config);

  // Apply models.dev metadata enrichment
  const withModelsDev =
    modelsDevIndex === null
      ? models
      : models.map((model) => applyModelsDevMetadata(model, config, modelsDevIndex));

  // Enrich combo models with lowest common capabilities
  const withComboCapabilities = await enrichComboModels(withModelsDev, config, modelsDevIndex);

  return withComboCapabilities;
}

/**
 * Apply models.dev metadata to a model
 */
function applyModelsDevMetadata(
  model: OmniRouteModel,
  config: OmniRouteConfig,
  index: ModelsDevIndex,
): OmniRouteModel {
  const { providerKey, modelKey } = splitModelId(model.id);
  const providerAlias = resolveProviderAlias(providerKey, config);
  const candidates = getModelLookupCandidates(modelKey);
  const providerCandidates = [
    ...(providerAlias ? [providerAlias] : []),
    ...(providerAlias
      ? [getSubscriptionFallback(providerAlias)].filter((p): p is string => p !== null)
      : []),
  ];

  debug(
    `models.dev lookup model=${sanitizeForLog(model.id)} ` +
      `providerKey=${sanitizeForLog(providerKey ?? 'null')} ` +
      `providerAlias=${sanitizeForLog(providerAlias ?? 'null')} ` +
      `providerCandidates=${sanitizeForLog(providerCandidates.join('|') || 'none')} ` +
      `modelCandidates=${sanitizeForLog(candidates.join('|'))}`,
  );

  const best = lookupModelsDevModel(index, providerCandidates, candidates);
  if (!best) {
    const exactCounts = candidates.map((candidate) => index.exactGlobal.get(candidate)?.length ?? 0);
    const normalizedCounts = candidates.map(
      (candidate) => index.normalizedGlobal.get(normalizeModelKey(candidate))?.length ?? 0,
    );
    debug(
      `models.dev miss model=${sanitizeForLog(model.id)} ` +
        `globalExactCounts=${summarizeMatchCounts(exactCounts)} ` +
        `globalNormalizedCounts=${summarizeMatchCounts(normalizedCounts)}`,
    );
    return model;
  }

  const shouldUseModelsDevName =
    typeof best.name === 'string' &&
    best.name.trim() !== '' &&
    (!model.name ||
      model.name === model.id ||
      model.name.includes('/') ||
      isSlugLikeModelName(model.name));

  debug(
    `models.dev hit model=${sanitizeForLog(model.id)} ` +
      `resolvedName=${sanitizeForLog(best.name || '')} ` +
      `currentName=${sanitizeForLog(model.name || '')} ` +
      `replaceName=${String(shouldUseModelsDevName)} ` +
      `context=${String(best.limit?.context ?? '')} ` +
      `output=${String(best.limit?.output ?? '')}`,
  );

  // Merge capabilities (only fill in missing values)
  return {
    ...model,
    ...(shouldUseModelsDevName ? { name: best.name } : {}),
    ...(model.contextWindow === undefined && best.limit?.context !== undefined
      ? { contextWindow: best.limit.context }
      : {}),
    ...(model.maxTokens === undefined && best.limit?.output !== undefined
      ? { maxTokens: best.limit.output }
      : {}),
    ...(model.supportsVision === undefined && best.modalities?.input?.includes('image')
      ? { supportsVision: true }
      : {}),
    ...(model.supportsTools === undefined && best.tool_call === true
      ? { supportsTools: true }
      : {}),
    ...(model.supportsStreaming === undefined
      ? { supportsStreaming: true }
      : {}),
    ...(model.supportsTemperature === undefined && best.temperature !== undefined
      ? { supportsTemperature: best.temperature }
      : {}),
    ...(model.supportsReasoning === undefined && best.reasoning !== undefined
      ? { supportsReasoning: best.reasoning }
      : {}),
    ...(model.supportsAttachment === undefined && best.attachment !== undefined
      ? { supportsAttachment: best.attachment }
      : {}),
  };
}

function getModelLookupCandidates(modelKey: string): string[] {
  const candidates = new Set<string>();

  const addCandidate = (key: string): void => {
    const lower = key.toLowerCase();
    const normalized = normalizeModelKey(key);
    const aliasResolved = resolveModelAlias(key);

    candidates.add(lower);
    candidates.add(normalized);

    // Only add alias variants if they differ from original
    if (aliasResolved !== key) {
      candidates.add(aliasResolved.toLowerCase());
      candidates.add(normalizeModelKey(aliasResolved));
    }
  };

  addCandidate(modelKey);

  const { base, stripped } = stripVariantSuffix(modelKey);
  if (stripped) {
    addCandidate(base);
  }

  return [...candidates];
}

function lookupModelsDevModel(
  index: ModelsDevIndex,
  providerCandidates: string[],
  modelCandidates: string[],
): ModelsDevModel | undefined {
  for (const provider of providerCandidates) {
    for (const candidate of modelCandidates) {
      const exact = index.exactByProvider.get(provider)?.get(candidate);
      if (exact) return exact;

      const normalized = index.normalizedByProvider
        .get(provider)
        ?.get(normalizeModelKey(candidate));
      if (normalized) return normalized;
    }
  }

  for (const candidate of modelCandidates) {
    const exactList = index.exactGlobal.get(candidate);
    if (exactList?.length === 1) return exactList[0];

    const normalizedList = index.normalizedGlobal.get(normalizeModelKey(candidate));
    if (normalizedList?.length === 1) return normalizedList[0];
  }

  return undefined;
}
