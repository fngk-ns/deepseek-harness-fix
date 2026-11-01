/**
 * AI Route provider: the account grant authenticates the pi-ai OpenAI-compatible transport, and the account's
 * `GET /models` listing is the whole catalog of the route, in the order the server lists it.
 * @module @deepseek-ai/dsh-llm-ai-route
 */
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-ai-route-account'
import type { AiRouteModel } from '@deepseek-ai/dsh-ai-route-account/types'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmModelBadge, LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { authContextFrom, credentialStoreFrom, PiAiAdapter, resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiModelProfile, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'

export const name = 'llm-ai-route'
export const inject = ['llm', 'aiRouteAccount']

export const PROVIDER = 'ai-route'
const LOG_TAG = '[llm-ai-route]'

export interface Config {
  /** Automatic listing refresh interval after first use. */
  modelsMaxAgeMs: number
}
export const Config = z.object({
  modelsMaxAgeMs: z.number().min(10_000).default(600_000),
})

/** Offered while no listing has loaded yet; `auto` exists on every plan that includes Auto. */
const FALLBACK_MODELS: AiRouteModel[] = [
  { id: 'auto', name: 'Auto', context_length: 1_000_000, tags: ['recommended'], free: false, uncensored: false },
]

const UNCENSORED_BADGE: LlmModelBadge = {
  text: { en: '🛡 Uncensored', zh: '🛡 无审查', ko: '🛡 무검열', ja: '🛡 無検閲' }, tone: 'warning',
}
const FREE_BADGE: LlmModelBadge = { text: { en: 'Free', zh: '免费', ko: '무료', ja: '無料' }, tone: 'success' }

export function apply(ctx: Context, config: Config): void {
  const account = ctx.aiRouteAccount
  const baseURL = account.baseURL

  // ---------- listing cache ----------
  let listing: AiRouteModel[] | undefined
  let listingAt = 0
  let loading: Promise<void> | undefined
  let disposed = false
  const load = async (): Promise<void> => {
    try {
      const next = await account.listModels()
      if (disposed) return
      const changed = JSON.stringify(next) !== JSON.stringify(listing)
      listing = next
      if (changed) ctx.emit('llm/models-updated', PROVIDER)
    } catch (error) {
      console.warn(LOG_TAG, 'model listing failed; keeping the previous listing:', error instanceof Error ? error.message : String(error))
    } finally {
      listingAt = Date.now()
    }
  }
  const ensure = (): Promise<void> => {
    if (loading !== undefined) return loading
    if (listing !== undefined && Date.now() - listingAt < config.modelsMaxAgeMs) return Promise.resolve()
    loading = load().finally(() => { loading = undefined })
    return loading
  }
  ctx.on('ai-route-account/changed', () => {
    listing = undefined
    listingAt = 0
    void ensure()
  })
  const timer = setInterval(() => { if (listing !== undefined) void ensure() }, config.modelsMaxAgeMs)
  ctx.effect(() => () => { disposed = true; clearInterval(timer) }, 'llm-ai-route: listing refresh')

  // ---------- profiles ----------
  let memoListing: AiRouteModel[] | undefined
  let memoProfiles: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  const profiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const source = listing !== undefined && listing.length > 0 ? listing : FALLBACK_MODELS
    if (memoProfiles !== undefined && memoListing === source) return memoProfiles
    const models: PiAiModelProfile[] = source.map(m => ({
      id: m.id,
      name: m.name,
      ...m.context_length > 0 ? { contextWindow: m.context_length } : {},
      input: m.id === 'auto' ? ['text', 'image'] : ['text'],
    }))
    memoProfiles = resolveProfiles({
      [PROVIDER]: { displayName: 'AI Route', api: 'openai-completions', baseURL, models },
    }, 'deferred')
    memoListing = source
    return memoProfiles
  }

  const resolveApiKey = async (): Promise<string | undefined> => {
    const token = await account.accessToken(baseURL)
    if (token === undefined) {
      throw new LlmError('Sign in to AI Route (Settings → AI Route) to use this provider.', 'MISSING_CREDENTIAL')
    }
    return token
  }

  /** The pi-ai adapter plus listing-driven badges and a listing wait before first use. */
  class AiRouteAdapter extends PiAiAdapter {
    override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
      await ensure()
      const base = await super.listModels(provider)
      const byId = new Map((listing ?? []).map(m => [m.id, m]))
      return base.map((model) => {
        const entry = byId.get(model.id)
        const badge = entry?.uncensored ? UNCENSORED_BADGE : entry?.free ? FREE_BADGE : undefined
        return badge === undefined ? model : { ...model, badge }
      })
    }
    override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
      await ensure()
      return super.resolveModel(provider, model, signal)
    }
    override async prepareCall(provider: string, model: string, signal?: AbortSignal): ReturnType<PiAiAdapter['prepareCall']> {
      await ensure()
      return super.prepareCall(provider, model, signal)
    }
  }

  const adapter = new AiRouteAdapter({
    profiles,
    resolveApiKey,
    auth: { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) },
    prepareHeaders: (_request, headers) => headers,
    onReplayDegrade: ({ model, reason }) => {
      ctx.logger.warn(`llm-ai-route: unusable replay state on assistant history for "${model}";`
        + ` sending provider-neutral content (${reason})`)
    },
  })
  ctx.llm.registerAdapter([PROVIDER], adapter)
  // Listed in the configurable-provider directory so first-run onboarding counts the route as a usable provider
  // (it authenticates through the account, so no credential reference is declared).
  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER, displayName: 'AI Route', settingsNs: ctx.fiber.entry?.options.id ?? name, settingsPath: [], declared: true,
  }])
  void ensure()
}
