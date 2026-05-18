import type { Plugin, PluginModule } from "@opencode-ai/plugin"

const PROVIDER_ID = "litellm"
const PROVIDER_NAME = "LiteLLM"
const DEFAULT_BASE_URL = "http://localhost:4000/v1"

type LiteLLMModel = Record<string, any>
type ModelModality = "text" | "audio" | "image" | "video" | "pdf"

const normalizeBaseURL = (value?: string) => {
  const input = (value ?? "").trim()
  if (!input) return DEFAULT_BASE_URL
  return input.replace(/\/$/, "")
}

const withV1 = (baseURL: string) => {
  const normalized = normalizeBaseURL(baseURL)
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`
}

const resolveAPIKey = (value: unknown) => {
  if (typeof value === "string" && value.trim()) return value.trim()
  return undefined
}

const getModelID = (item: any) => {
  if (typeof item === "string") return item
  if (typeof item?.model_name === "string") return item.model_name
  if (typeof item?.id === "string") return item.id
  if (typeof item?.model === "string") return item.model
  if (typeof item?.litellm_params?.model === "string") return item.litellm_params.model
  return undefined
}

const toModality = (value: unknown): ModelModality | undefined => {
  if (typeof value !== "string") return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === "text" || normalized === "audio" || normalized === "image" || normalized === "video" || normalized === "pdf") {
    return normalized
  }
  return undefined
}

const uniqueModalities = (values: unknown[]) => {
  const seen = new Set<ModelModality>()
  const output: ModelModality[] = []
  for (const value of values) {
    const modality = toModality(value)
    if (!modality || seen.has(modality)) continue
    seen.add(modality)
    output.push(modality)
  }
  return output
}

const parseModalityArray = (value: unknown) => {
  if (!Array.isArray(value)) return []
  return uniqueModalities(value)
}

const inferModalities = (modelInfo: Record<string, any>) => {
  const directInput = parseModalityArray(modelInfo.modalities?.input)
  const directOutput = parseModalityArray(modelInfo.modalities?.output)
  if (directInput.length > 0 || directOutput.length > 0) {
    return { input: directInput.length > 0 ? directInput : ["text"], output: directOutput.length > 0 ? directOutput : ["text"] }
  }

  const input = ["text"] as ModelModality[]
  const output = ["text"] as ModelModality[]

  if (modelInfo.supports_vision || modelInfo.supports_image_input || modelInfo.supports_images) {
    input.push("image")
  }
  if (modelInfo.supports_pdf_input) {
    input.push("pdf")
  }
  if (modelInfo.supports_audio_input || modelInfo.supports_audio) {
    input.push("audio")
  }
  if (modelInfo.supports_video_input) {
    input.push("video")
  }
  if (modelInfo.supports_audio_output || modelInfo.supports_speech) {
    output.push("audio")
  }
  if (modelInfo.supports_image_output || modelInfo.supports_image_generation) {
    output.push("image")
  }
  if (modelInfo.supports_video_output || modelInfo.supports_video_generation) {
    output.push("video")
  }

  return {
    input: uniqueModalities(input),
    output: uniqueModalities(output),
  }
}

const getModelName = (modelInfo: Record<string, any>, fallbackID: string) => {
  if (typeof modelInfo?.name === "string" && modelInfo.name.trim()) return modelInfo.name
  if (typeof modelInfo?.display_name === "string" && modelInfo.display_name.trim()) return modelInfo.display_name
  if (typeof modelInfo?.model_name === "string" && modelInfo.model_name.trim()) return modelInfo.model_name
  if (typeof modelInfo?.litellm_params?.model === "string" && modelInfo.litellm_params.model.trim()) {
    return modelInfo.litellm_params.model
  }
  return fallbackID
}

const getNumber = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

const toLimit = (value: unknown) => {
  const num = getNumber(value)
  if (num === undefined) return undefined
  if (num <= 0) return undefined
  return Math.floor(num)
}

const toPrice = (value: unknown) => {
  const num = getNumber(value)
  if (num === undefined) return undefined
  if (num < 0) return undefined
  return num
}

const flattenModelInfo = (value: unknown) => {
  if (!value || typeof value !== "object") return {}

  const item = value as Record<string, unknown>
  const nestedInfo =
    item.model_info && typeof item.model_info === "object"
      ? (item.model_info as Record<string, unknown>)
      : {}

  return {
    ...item,
    ...nestedInfo,
  }
}

const buildHeaders = (apiKey?: string) => {
  const headers: Record<string, string> = {
    Accept: "application/json",
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return headers
}

const getProviderID = (provider: any) => provider?.info?.id ?? provider?.id

const mergeTags = (...groups: unknown[]) => {
  const seen = new Set<string>()
  const tags: string[] = []

  for (const group of groups) {
    if (!Array.isArray(group)) continue
    for (const item of group) {
      if (typeof item !== "string") continue
      const tag = item.trim()
      if (!tag || seen.has(tag)) continue
      seen.add(tag)
      tags.push(tag)
    }
  }

  return tags
}

const buildRequestTags = (input: { sessionID: string; agent: string; model: { id: string } }) => [
  "opencode",
  `opencode-session:${input.sessionID}`,
  `opencode-agent:${input.agent}`,
  `opencode-model:${input.model.id}`,
]

const buildSpendLogsMetadata = (input: {
  sessionID: string
  agent: string
  model: { id: string }
  provider: any
  message: { id: string }
}) => ({
  opencode_session_id: input.sessionID,
  opencode_message_id: input.message.id,
  opencode_agent: input.agent,
  opencode_model: input.model.id,
  opencode_provider: getProviderID(input.provider),
})

const fetchLiteLLMModelMap = async (baseURL: string, apiKey?: string) => {
  const headers = buildHeaders(apiKey)
  let infoByModelID = new Map<string, LiteLLMModel>()
  let modelInfoItems: LiteLLMModel[] = []

  try {
    const infoResponse = await fetch(`${baseURL}/model/info`, {
      method: "GET",
      headers,
    })

    if (infoResponse.ok) {
      const infoPayload = (await infoResponse.json()) as
        | { data?: any[]; model_info?: Record<string, any> }
        | undefined

      if (Array.isArray(infoPayload?.data)) {
        modelInfoItems = infoPayload.data
        for (const item of infoPayload.data) {
          const id = getModelID(item)
          if (!id) continue
          infoByModelID.set(id, flattenModelInfo(item))
        }
      }

      if (infoPayload?.model_info && typeof infoPayload.model_info === "object") {
        for (const [id, value] of Object.entries(infoPayload.model_info)) {
          infoByModelID.set(id, {
            ...(infoByModelID.get(id) ?? {}),
            ...value,
          })
        }
      }
    }
  } catch {
    infoByModelID = new Map<string, LiteLLMModel>()
    modelInfoItems = []
  }

  if (modelInfoItems.length > 0) {
    const output: Record<string, any> = {}

    for (const item of modelInfoItems) {
      const id = getModelID(item)
      if (!id) continue

      const modelInfo = flattenModelInfo(item)
      const inputLimit =
        toLimit(modelInfo?.max_input_tokens) ??
        toLimit(modelInfo?.max_context_tokens) ??
        toLimit(modelInfo?.context_window) ??
        toLimit(modelInfo?.max_tokens)
      const outputLimit =
        toLimit(modelInfo?.max_output_tokens) ??
        toLimit(modelInfo?.max_completion_tokens) ??
        toLimit(modelInfo?.max_tokens)

      output[id] = {
        id,
        name: getModelName(modelInfo, id),
        modalities: inferModalities(modelInfo),
        limit: {
          context: inputLimit,
          input: inputLimit,
          output: outputLimit,
        },
        cost: {
          input:
            toPrice(modelInfo?.input_cost_per_token) ??
            toPrice(modelInfo?.input_cost_per_input_token),
          output:
            toPrice(modelInfo?.output_cost_per_token) ??
            toPrice(modelInfo?.output_cost_per_output_token),
        },
      }
    }

    if (Object.keys(output).length > 0) return output
  }

  const response = await fetch(`${baseURL}/models`, {
    method: "GET",
    headers,
  })

  if (!response.ok) {
    throw new Error(`LiteLLM model discovery failed (${response.status})`)
  }

  const payload = (await response.json()) as { data?: any[] }
  const output: Record<string, any> = {}

  for (const item of payload.data ?? []) {
    const id = getModelID(item)
    if (!id) continue

    const info = infoByModelID.get(id) ?? {}
    const modelInfo = {
      ...info,
      ...flattenModelInfo(item),
    }
    const inputLimit =
      toLimit(modelInfo?.max_input_tokens) ??
      toLimit(modelInfo?.max_context_tokens) ??
      toLimit(modelInfo?.context_window) ??
      toLimit(modelInfo?.max_tokens)
    const outputLimit =
      toLimit(modelInfo?.max_output_tokens) ??
      toLimit(modelInfo?.max_completion_tokens) ??
      toLimit(modelInfo?.max_tokens)

    output[id] = {
      id,
      name: getModelName(modelInfo, id),
      modalities: inferModalities(modelInfo),
      limit: {
        context: inputLimit,
        input: inputLimit,
        output: outputLimit,
      },
      cost: {
        input:
          toPrice(modelInfo?.input_cost_per_token) ??
          toPrice(modelInfo?.input_cost_per_input_token),
        output:
          toPrice(modelInfo?.output_cost_per_token) ??
          toPrice(modelInfo?.output_cost_per_output_token),
      },
    }
  }

  return output
}

const server: Plugin = async () => {
  return {
    config: async (input) => {
      const current = input.provider?.[PROVIDER_ID] ?? {}
      const options = current.options ?? {}
      const explicitApiKey = resolveAPIKey(options.apiKey) ?? resolveAPIKey(options.apikey)
      const envApiKey = resolveAPIKey(process.env.LITELLM_API_KEY) ?? resolveAPIKey(process.env.LITELLM_VIRTUAL_KEY)
      const configuredAPIKey = explicitApiKey ?? envApiKey
      const existingHeaders = { ...(options.headers ?? {}) } as Record<string, string>
      const resolvedBaseURL = withV1(options.baseURL ?? process.env.LITELLM_BASE_URL)

      if (configuredAPIKey && !existingHeaders.Authorization) {
        existingHeaders.Authorization = `Bearer ${configuredAPIKey}`
      }

      input.provider ??= {}
      input.provider[PROVIDER_ID] = {
        npm: "@ai-sdk/openai-compatible",
        name: PROVIDER_NAME,
        ...current,
        options: {
          ...options,
          baseURL: resolvedBaseURL,
          includeUsage: options.includeUsage ?? true,
          apiKey: configuredAPIKey,
          apikey: configuredAPIKey,
          headers: existingHeaders,
        },
      }

      try {
        const liveModels = await fetchLiteLLMModelMap(resolvedBaseURL, configuredAPIKey)

        if (Object.keys(liveModels).length > 0) {
          const mergedModels: Record<string, any> = {
            ...(current.models ?? {}),
          }

          for (const [modelID, liveModel] of Object.entries(liveModels)) {
            mergedModels[modelID] = {
              ...(mergedModels[modelID] ?? {}),
              ...liveModel,
              id: liveModel.id,
              name: liveModel.name,
              modalities: liveModel.modalities,
            }
          }

          input.provider[PROVIDER_ID].models = {
            ...mergedModels,
          }
        }
      } catch {
        // no-op: avoid blocking provider initialization if live discovery fails
      }

    },

    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "api",
          label: "Virtual key",
          prompts: [
            {
              type: "text",
              key: "baseURL",
              message: "LiteLLM base URL",
              placeholder: "http://localhost:4000/v1",
            },
            {
              type: "text",
              key: "key",
              message: "LiteLLM virtual key",
              validate: (value) => (value.trim() ? undefined : "Virtual key is required"),
            },
          ],
          async authorize(inputs) {
            const key = inputs?.key?.trim()
            if (!key) return { type: "failed" }
            return {
              type: "success",
              key,
            }
          },
        },
      ],
    },

    provider: {
      id: PROVIDER_ID,
      models: async (provider, ctx) => {
        const baseURL = withV1(provider.options?.baseURL ?? process.env.LITELLM_BASE_URL)
        const authKey =
          ctx.auth?.key ||
          resolveAPIKey(provider.options?.apiKey) ||
          resolveAPIKey(provider.options?.apikey) ||
          process.env.LITELLM_API_KEY ||
          process.env.LITELLM_VIRTUAL_KEY

        return fetchLiteLLMModelMap(baseURL, authKey)
      },
    },

    "chat.params": async (input, output) => {
      if (getProviderID(input.provider) !== PROVIDER_ID) return

      const tags = mergeTags(output.options.tags, output.options.metadata?.tags, buildRequestTags(input))

      output.options = {
        ...output.options,
        litellm_session_id: input.sessionID,
        tags,
        metadata: {
          ...(output.options.metadata ?? {}),
          tags,
          spend_logs_metadata: {
            ...(output.options.metadata?.spend_logs_metadata ?? {}),
            ...buildSpendLogsMetadata(input),
          },
        },
      }
    },

    "chat.headers": async (input, output) => {
      const providerID = getProviderID(input.provider)
      if (providerID !== PROVIDER_ID) return

      const tags = buildRequestTags(input)

      output.headers["X-OpenCode-Session-ID"] = input.sessionID
      output.headers["X-OpenCode-Agent"] = input.agent
      output.headers["X-OpenCode-Model"] = input.model.id
      output.headers["X-OpenCode-Provider"] = providerID
      output.headers["x-litellm-tags"] = tags.join(",")
      output.headers["x-litellm-spend-logs-metadata"] = JSON.stringify(buildSpendLogsMetadata(input))
      if (input.provider?.source) {
        output.headers["X-OpenCode-Provider-Source"] = input.provider.source
      }
      output.headers["X-OpenCode-Message-ID"] = input.message.id
    },
  }
}

const plugin: PluginModule & { id: string } = {
  id: "litellm-provider",
  server,
}

export default plugin
