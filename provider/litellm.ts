import type { Plugin, PluginModule } from "@opencode-ai/plugin"

const PROVIDER_ID = "litellm"
const PROVIDER_NAME = "LiteLLM"
const DEFAULT_BASE_URL = "http://localhost:4000/v1"

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
  if (typeof item?.id === "string") return item.id
  if (typeof item?.model_name === "string") return item.model_name
  return undefined
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
          apiKey: configuredAPIKey,
          apikey: configuredAPIKey,
          headers: existingHeaders,
        },
      }

      try {
        const response = await fetch(`${resolvedBaseURL}/models`, {
          method: "GET",
          headers: buildHeaders(configuredAPIKey),
        })

        if (response.ok) {
          const payload = (await response.json()) as { data?: any[] }
          const liveModels: Record<string, any> = {}

          for (const item of payload.data ?? []) {
            const id = getModelID(item)
            if (!id) continue
            liveModels[id] = {
              name: typeof item?.name === "string" ? item.name : id,
            }
          }

          if (Object.keys(liveModels).length > 0) {
            input.provider[PROVIDER_ID].models = {
              ...(current.models ?? {}),
              ...liveModels,
            }
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
        const headers: Record<string, string> = {
          ...buildHeaders(undefined),
        }

        const authKey =
          ctx.auth?.key ||
          resolveAPIKey(provider.options?.apiKey) ||
          resolveAPIKey(provider.options?.apikey) ||
          process.env.LITELLM_API_KEY ||
          process.env.LITELLM_VIRTUAL_KEY
        if (authKey) headers.Authorization = `Bearer ${authKey}`

        let infoByModelID = new Map<string, any>()
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
          infoByModelID = new Map<string, any>()
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
          const outputLimit = toLimit(modelInfo?.max_output_tokens)

          output[id] = {
            id,
            name:
              (typeof modelInfo?.name === "string" && modelInfo.name) ||
              (typeof modelInfo?.model_name === "string" && modelInfo.model_name) ||
              id,
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
      },
    },

    "chat.headers": async (input, output) => {
      const providerID = input.provider?.info?.id
      if (providerID !== PROVIDER_ID) return

      output.headers["X-OpenCode-Session-ID"] = input.sessionID
      output.headers["X-OpenCode-Agent"] = input.agent
      output.headers["X-OpenCode-Model"] = input.model.id
      output.headers["X-OpenCode-Provider"] = providerID
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
