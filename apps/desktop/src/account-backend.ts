/**
 * Native account commands and Gateway state stream; no renderer receives credentials.
 * The desktop signs in to AI Route (`aiRoute` Remote namespace); its view is projected onto the
 * account shape the welcome window renders.
 */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { parseRemoteStreamServerMessage, REMOTE_STREAM_MUX_PATH } from '@deepseek-ai/dsh-api-gateway/stream-protocol'
import type { AccountClientMetadata, AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'

/** Authenticated unary caller shared with native onboarding. */
export type AccountInvoke = (request: { namespace: string; method: string; args: Record<string, unknown> }) => Promise<unknown>

/** The single AI Route attempt id: the account service keeps at most one attempt. */
const AI_ROUTE_ATTEMPT_ID = 'ai-route' as SignInAttemptId

/**
 * Project an AI Route account view (`signed-in` / `signed-out`, one unnamed attempt) onto the welcome account shape.
 * @param value - wire value of `aiRoute/*`.
 * @returns the account-shaped wire value, validated by {@link accountView} afterwards.
 */
function fromAiRoute(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('status' in value) || !('attempt' in value)) return value
  const view = value as { status: unknown; attempt: unknown; dashboardUrl?: unknown }
  const dashboard = typeof view.dashboardUrl === 'string' ? view.dashboardUrl : 'https://aiapi.hoj.kr'
  const attempt = view.attempt
  return {
    status: view.status === 'signed-in' ? 'credential-stored' : view.status,
    links: { usageUrl: dashboard, topUpUrl: dashboard },
    attempt: typeof attempt !== 'object' || attempt === null ? null : {
      id: AI_ROUTE_ATTEMPT_ID,
      ...attempt,
      ...('error' in attempt ? { errorCode: 'protocol' } : {}),
    },
  }
}

/** Decode the UI-safe state received across HTTP or WebSocket. @param value - wire value. @returns account projection. */
export function accountView(value: unknown): AccountView {
  if (typeof value !== 'object' || value === null || !('status' in value)
    || !['signed-out', 'credential-stored'].includes(String(value.status)) || !('attempt' in value)) {
    throw new Error('desktop account: invalid state')
  }
  if (!('links' in value) || typeof value.links !== 'object' || value.links === null
    || !('usageUrl' in value.links) || typeof value.links.usageUrl !== 'string'
    || !('topUpUrl' in value.links) || typeof value.links.topUpUrl !== 'string') {
    throw new Error('desktop account: invalid platform links')
  }
  validateBrowserDestination(value.links.usageUrl)
  validateBrowserDestination(value.links.topUpUrl)
  const attempt = value.attempt
  if (attempt !== null && (typeof attempt !== 'object' || !('id' in attempt) || typeof attempt.id !== 'string'
    || !('phase' in attempt) || !['initializing', 'waiting-browser', 'exchanging', 'committing', 'succeeded', 'cancelled', 'expired', 'failed'].includes(String(attempt.phase))
    || ('authorizeUrl' in attempt && typeof attempt.authorizeUrl !== 'string')
    || ('expiresAt' in attempt && (typeof attempt.expiresAt !== 'number' || !Number.isFinite(attempt.expiresAt)))
    || ('errorCode' in attempt && !['no-response', 'network', 'protocol', 'expired', 'storage'].includes(String(attempt.errorCode))))) {
    throw new Error('desktop account: invalid attempt')
  }
  if (attempt !== null && 'authorizeUrl' in attempt) {
    validateBrowserDestination(String(attempt.authorizeUrl))
  }
  const parsed = value as AccountView
  return {
    status: parsed.status,
    links: { usageUrl: parsed.links.usageUrl, topUpUrl: parsed.links.topUpUrl },
    attempt: parsed.attempt === null ? null : {
      id: parsed.attempt.id, phase: parsed.attempt.phase,
      ...parsed.attempt.authorizeUrl === undefined ? {} : { authorizeUrl: parsed.attempt.authorizeUrl },
      ...parsed.attempt.expiresAt === undefined ? {} : { expiresAt: parsed.attempt.expiresAt },
      ...parsed.attempt.errorCode === undefined ? {} : { errorCode: parsed.attempt.errorCode },
    },
  }
}

/** Only HTTP loopback or HTTPS destinations can leave the native app. */
function validateBrowserDestination(value: string): void {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || !(url.protocol === 'https:' || (loopback && url.protocol === 'http:'))) {
    throw new Error('desktop account: invalid browser destination')
  }
}

/** Native account operations and explicitly owned stream lifetime. */
export interface DesktopAccountBackend {
  /** @returns current account snapshot. */
  state(): Promise<AccountView>
  /** @param client - this window's identity and current language. @returns new or already-running login attempt. */
  start(client: AccountClientMetadata): Promise<AccountView>
  /** @param id - attempt to cancel. @returns cancellation or completed commit state. */
  cancel(id: SignInAttemptId): Promise<AccountView>
  /** @param client - this window's identity. @returns state after local sign-out. */
  signOut(client: AccountClientMetadata): Promise<AccountView>
  /**
   * @param listener - state recipient.
   * @param failed - stream failure recipient.
   * @param expired - live credential-expiry recipient (a stored account that disappears).
   * @param onAnalyticsEnabledChanged - optional Desktop collection-policy recipient; disconnected streams publish false.
   * @returns stream disposer.
   */
  watch(
    listener: (state: AccountView) => void, failed: () => void, expired: () => void,
    onAnalyticsEnabledChanged?: (enabled: boolean) => void,
  ): () => void
}

/**
 * Connect native account operations to the AI Route account over the standard authenticated Web backend.
 * @param origin - Host Web origin.
 * @param invoke - validated unary RPC caller.
 * @param cookies - Electron session cookie reader.
 * @returns account operations; watch callers own their subscriptions.
 */
export function desktopAccountBackend(origin: string, invoke: AccountInvoke, cookies: () => Promise<string>): DesktopAccountBackend {
  const call = async (method: string, args: Record<string, unknown> = {}): Promise<AccountView> =>
    accountView(fromAiRoute(await invoke({ namespace: 'aiRoute', method, args })))
  return {
    state: () => call('getState'),
    start: () => call('startSignIn', { callbackOrigin: new URL(origin).origin }),
    cancel: () => call('cancelSignIn'), signOut: () => call('signOut'),
    watch(listener, failed, expired, onAnalyticsEnabledChanged) {
      let closed = false
      let socket: WebSocket | undefined
      let retry: ReturnType<typeof setTimeout> | undefined
      let lastStatus: AccountView['status'] | undefined
      const connect = (): void => {
        const streamId = randomUUID()
        const analyticsPolicyStreamId = randomUUID()
        void cookies().then((cookie) => {
          if (closed) return
          const url = new URL(REMOTE_STREAM_MUX_PATH, origin)
          url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
          socket = new WebSocket(url, { headers: { cookie, origin }, maxPayload: 65_536 })
          socket.on('open', () => {
            if (onAnalyticsEnabledChanged !== undefined) socket?.send(JSON.stringify({ type: 'open', streamId: analyticsPolicyStreamId, endpoint: 'productAnalytics/watchPolicy', payload: { args: {} } }))
            socket?.send(JSON.stringify({ type: 'open', streamId, endpoint: 'aiRoute/watch', payload: { args: {} } }))
          })
          socket.on('message', (data) => {
            try {
              const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
              const frame = parseRemoteStreamServerMessage(bytes.toString('utf8'))
              if (frame.streamId === analyticsPolicyStreamId) {
                if (frame.type === 'item' && typeof frame.value === 'boolean') onAnalyticsEnabledChanged?.(frame.value)
                else onAnalyticsEnabledChanged?.(false)
                return
              }
              if (frame.streamId !== streamId) throw new Error('desktop account: unexpected stream')
              if (frame.type === 'item') {
                const state = accountView(fromAiRoute(frame.value))
                // AI Route has no separate expiry stream: a stored grant that vanishes outside an attempt is an expiry.
                if (lastStatus === 'credential-stored' && state.status === 'signed-out' && state.attempt === null) expired()
                lastStatus = state.status
                listener(state)
              } else socket?.close()
            } catch { socket?.close() }
          })
          socket.on('error', () => { socket?.close() })
          socket.on('close', () => { if (!closed) { onAnalyticsEnabledChanged?.(false); failed(); retry = setTimeout(connect, 1000) } })
        }).catch(() => { if (!closed) { onAnalyticsEnabledChanged?.(false); failed(); retry = setTimeout(connect, 1000) } })
      }
      connect()
      return () => { closed = true; onAnalyticsEnabledChanged?.(false); clearTimeout(retry); socket?.close() }
    },
  }
}
