/** AI Route settings registration and the reconnecting account subscription. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { AiRouteAccountView } from '@deepseek-ai/dsh-ai-route-account/types'
import { AiRouteSection, type AiRouteSectionInjected, type AiRouteSnapshot } from './AiRouteSection.tsx'
import { en, ko, zh, type AiRouteKey } from './locales.ts'
export type { AiRouteSectionInjected, AiRouteSnapshot } from './AiRouteSection.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.ai-route': AiRouteKey }
}

/** Services required by the AI Route settings page. */
export const inject = ['slots', 'locale', 'remote', 'remote.aiRoute', 'remoteAccess']

/** Register the AI Route section in Desktop and plain Web clients. @param ctx - client plugin context. */
export function apply(ctx: Context): void {
  const desktop = 'dshDesktop' in globalThis
  ctx.effect(() => ctx.locale.register('settings.ai-route', { en, ko, zh }), 'ai-route: dictionaries')
  const t = ctx.locale.bind('settings.ai-route')
  let snapshot: AiRouteSnapshot = {
    view: undefined, usage: undefined, models: undefined, failed: false, language: ctx.locale.getSnapshot().active,
  }
  const listeners = new Set<() => void>()
  const publish = (value: AiRouteSnapshot) => { snapshot = value; for (const listener of listeners) listener() }
  ctx.effect(() => ctx.on('locale/change', () => {
    publish({ ...snapshot, language: ctx.locale.getSnapshot().active })
  }), 'ai-route: language')

  /** Open a URL in the system browser: Desktop routes window.open to the shell; a browser opens a tab. */
  const openUrl = (url: string): void => {
    if (!/^https?:\/\//.test(url)) return
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  let revision = 0
  let reading: Promise<void> | undefined
  const refresh = (): Promise<void> => {
    if (snapshot.view?.status !== 'signed-in') return Promise.resolve()
    if (reading !== undefined) return reading
    const generation = revision
    const request = (async () => {
      const [usage, models] = await Promise.all([ctx.remote.aiRoute.getUsage(), ctx.remote.aiRoute.listModels()])
      if (generation !== revision) return
      if (!usage.ok || !models.ok) { publish({ ...snapshot, failed: true }); return }
      publish({ ...snapshot, usage: usage.value, models: models.value, failed: false })
    })()
    reading = request
    void request.finally(() => { if (reading === request) reading = undefined })
    return request
  }

  const callbackOrigin = (): string => {
    const transport = (globalThis as typeof globalThis & { __DSH_TRANSPORT__?: { streamBaseUrl?: string } }).__DSH_TRANSPORT__
    return desktop && transport?.streamBaseUrl !== undefined ? new URL(transport.streamBaseUrl).origin : window.location.origin
  }

  const operations: AiRouteSectionInjected = {
    hooks: {
      account: {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      },
    },
    openUrl,
    refresh,
    async start() {
      const result = await ctx.remote.aiRoute.startSignIn(callbackOrigin())
      if (!result.ok) throw new Error('ai-route start failed')
      const url = result.value.attempt?.authorizeUrl
      if (url !== undefined) openUrl(url)
    },
    async cancel() {
      const result = await ctx.remote.aiRoute.cancelSignIn()
      if (!result.ok) throw new Error('ai-route cancel failed')
    },
    async signOut() {
      const result = await ctx.remote.aiRoute.signOut()
      if (!result.ok) throw new Error('ai-route sign-out failed')
    },
  }

  // The account stream and the reads it starts follow access to this Host's AI Route state.
  ctx.remoteAccess.whenAccess('aiRoute/watch', function* () {
    const stream = ctx.remote.$stream<AiRouteAccountView>({
      name: 'aiRoute', open: signal => ctx.remote.aiRoute.watch(signal), ended: () => new Error('ai-route stream ended'),
    })
    const grant = { ended: false }
    yield () => {
      grant.ended = true
      revision++
      reading = undefined
      publish({ ...snapshot, view: undefined, usage: undefined, models: undefined, failed: false })
      return stream.dispose()
    }
    void (async () => {
      for await (const frame of stream) {
        if (grant.ended) return
        revision++
        reading = undefined
        const wasSignedIn = snapshot.view?.status === 'signed-in'
        const nowSignedIn = frame.value.status === 'signed-in'
        // A frame while the browser is still open does not drop the usage already shown; a sign-in change does.
        const keep = wasSignedIn && nowSignedIn
        publish({ ...snapshot, view: frame.value, failed: false, ...keep ? {} : { usage: undefined, models: undefined } })
        frame.accept()
        // A new login's authorization page opens from the click; a reconnect must not reopen it.
        if (nowSignedIn && (!keep || frame.value.attempt?.phase === 'succeeded')) void refresh()
      }
    })().catch(() => { if (!grant.ended) publish({ ...snapshot, failed: true }) })
  })

  ctx.remoteAccess.whenAccess('aiRoute/watch', () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'ai-route', order: -5, label: () => t('nav'),
    locale: 'settings.ai-route', inject: () => operations,
  }, AiRouteSection)))
}
