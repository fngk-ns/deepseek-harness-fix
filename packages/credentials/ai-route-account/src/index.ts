/**
 * AI Route account: browser PKCE sign-in against https://aiapi.hoj.kr, an access/refresh grant in the credential
 * store, and authenticated reads of the account's usage and model list. Browser approval never bypasses local
 * cancellation, and no secret leaves this module except as a bearer header to the configured origin.
 * @module @deepseek-ai/dsh-ai-route-account
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { hostname } from 'node:os'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { AiRouteAccountView, AiRouteModel, AiRouteSignInAttempt, AiRouteUsage } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The AI Route account seam. */
    aiRouteAccount: AiRouteAccount
  }
  interface Events {
    /**
     * The stored grant or the sign-in attempt changed.
     * @mode emit
     */
    'ai-route-account/changed'(): void
  }
}

const KEY = credentialKey('ai-route-account', 'default')
/** Loopback callback path; distinct from the DeepSeek provider's `/oauth/callback` so both can run at once. */
export const CALLBACK_PATH = '/oauth/ai-route/callback'

const grantSchema = z.object({
  version: z.literal(1),
  issuer: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** Epoch milliseconds. */
  accessExpiresAt: z.number(),
  refreshExpiresAt: z.number(),
  username: z.string().nullable(),
})
type Grant = z.infer<typeof grantSchema>

const tokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().min(1),
  scope: z.string().optional(),
})

/** Deployment options. */
export interface Config {
  /** OpenAI-compatible API root, including `/api/v1`. */
  baseURL?: string
  /** Public OAuth client id registered at the server. */
  clientId?: string
  /** Deadline for one HTTP request. */
  requestTimeoutMs?: number
  /** Upper bound of one browser sign-in attempt. */
  attemptTimeoutMs?: number
}
export const Config = Schema.object({
  baseURL: Schema.string().default('https://aiapi.hoj.kr/api/v1'),
  clientId: Schema.string().default('deepseek-harness'),
  requestTimeoutMs: Schema.number().min(1).max(120_000).default(30_000),
  attemptTimeoutMs: Schema.number().min(1).max(3_600_000).default(600_000),
})

interface Attempt {
  view: AiRouteSignInAttempt
  controller: AbortController
  callback?: ServerResponse
  dispose?: (() => void) | undefined
  done: Promise<void>
}

export class AiRouteAccountError extends Error {
  constructor(readonly code: 'protocol' | 'storage' | 'expired' | 'cancelled' | 'denied' | 'network', message?: string) {
    super(message ?? code)
  }
}

/** Account service: one attempt at a time, grant in the credential store, token refresh under the store's lock. */
export class AiRouteAccount extends Service {
  static inject = ['credentials']
  static Config = Config
  readonly baseURL: string
  readonly origin: string
  private readonly clientId: string
  private readonly requestTimeout: number
  private readonly attemptTimeout: number
  private attempt: Attempt | undefined
  private readonly listeners = new Set<() => void>()
  private refreshing: Promise<string | undefined> | undefined

  /** @param ctx - Host with the credentials service. @param config - deployment options. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'aiRouteAccount')
    const resolved = Config(config)
    const base = new URL(resolved.baseURL)
    if (base.protocol !== 'https:' && !isLoopback(base)) {
      throw new Error('ai-route-account: baseURL must be HTTPS (or loopback for development)')
    }
    this.baseURL = resolved.baseURL.replace(/\/+$/, '')
    this.origin = base.origin
    this.clientId = resolved.clientId
    this.requestTimeout = resolved.requestTimeoutMs
    this.attemptTimeout = resolved.attemptTimeoutMs
    ctx.on('credentials/record-updated', (key) => { if (key === KEY) this.changed() })
    ctx.effect(() => () => { this.attempt?.controller.abort(new AiRouteAccountError('cancelled')) }, 'ai-route-account: pending attempt')
  }

  // ---------- state ----------

  /** @returns stored-account presence and the current attempt, without credentials. */
  async getState(): Promise<AiRouteAccountView> {
    const grant = await this.readGrant()
    return {
      status: grant === undefined ? 'signed-out' : 'signed-in',
      username: grant?.username ?? null,
      dashboardUrl: this.origin,
      attempt: this.attempt?.view ?? null,
    }
  }

  /**
   * Stream the account view: the current state first, then every change.
   * @param signal - stream lifetime.
   */
  async *watch(signal: AbortSignal): AsyncIterable<AiRouteAccountView> {
    let wake: (() => void) | undefined
    let pending = true
    const listener = (): void => { pending = true; wake?.() }
    this.listeners.add(listener)
    const abort = (): void => { wake?.() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted) {
        if (pending) { pending = false; yield await this.getState(); continue }
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
    } finally {
      this.listeners.delete(listener)
      signal.removeEventListener('abort', abort)
    }
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
    this.ctx.emit('ai-route-account/changed')
  }

  // ---------- sign-in ----------

  /**
   * Begin a browser sign-in, or return the attempt already in flight.
   * @param callbackOrigin - loopback HTTP origin of the Host web server the browser can reach.
   */
  async startSignIn(callbackOrigin: string): Promise<AiRouteAccountView> {
    if (this.attempt !== undefined && isActive(this.attempt.view.phase)) return this.getState()
    const origin = loopbackOrigin(callbackOrigin)
    const controller = new AbortController()
    const attempt: Attempt = {
      view: { phase: 'waiting-browser', expiresAt: Date.now() + this.attemptTimeout },
      controller,
      done: Promise.resolve(),
    }
    this.attempt = attempt
    attempt.done = this.run(attempt, origin).catch((error: unknown) => {
      const code = error instanceof AiRouteAccountError ? error.code : 'protocol'
      if (code === 'cancelled') this.update(attempt, { phase: 'cancelled' })
      else if (code === 'expired') this.update(attempt, { phase: 'expired' })
      else this.update(attempt, { phase: 'failed', error: code === 'protocol' && error instanceof Error ? error.message : code })
      console.warn('[ai-route-account] sign-in failed:', error instanceof Error ? error.message : String(error))
    }).finally(() => {
      attempt.dispose?.()
      attempt.dispose = undefined
    })
    this.changed()
    return this.getState()
  }

  /** Cancel the current attempt, if any. */
  async cancelSignIn(): Promise<AiRouteAccountView> {
    const attempt = this.attempt
    if (attempt !== undefined && isActive(attempt.view.phase)) {
      attempt.controller.abort(new AiRouteAccountError('cancelled'))
      await attempt.done
    }
    return this.getState()
  }

  private update(attempt: Attempt, view: AiRouteSignInAttempt): void {
    if (this.attempt !== attempt) return
    const expiresAt = view.expiresAt ?? attempt.view.expiresAt
    attempt.view = { ...view, ...expiresAt === undefined ? {} : { expiresAt } }
    this.changed()
  }

  private async run(attempt: Attempt, callbackOrigin: string): Promise<void> {
    const webServer = this.ctx.get('webServer')
    if (webServer === undefined) throw new AiRouteAccountError('protocol', 'no web server to receive the browser callback')
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const code = Promise.withResolvers<string>()
    void code.promise.catch(() => undefined)
    const signal = AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(this.attemptTimeout)])
    const onAbort = (): void => {
      code.reject(attempt.controller.signal.aborted ? attempt.controller.signal.reason : new AiRouteAccountError('expired'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const redirectUri = `${callbackOrigin}${CALLBACK_PATH}`
    try {
      attempt.dispose = this.ctx.effect(() => webServer.register({
        kind: 'exact', path: CALLBACK_PATH, handler: (req, res) => {
          let url: URL
          try { url = new URL(req.url ?? '/', 'http://127.0.0.1') }
          catch { res.writeHead(400, { 'cache-control': 'no-store' }).end(); return }
          const receivedState = url.searchParams.get('state') ?? ''
          const validState = Buffer.byteLength(receivedState) === Buffer.byteLength(state)
            && timingSafeEqual(Buffer.from(receivedState), Buffer.from(state))
          if (req.method !== 'GET' || !validState) { res.writeHead(400, { 'cache-control': 'no-store' }).end('Bad request'); return }
          if (signal.aborted || attempt.callback !== undefined || attempt.view.phase !== 'waiting-browser') {
            res.writeHead(410, { 'cache-control': 'no-store' }).end('This sign-in attempt is no longer active.'); return
          }
          const error = url.searchParams.get('error')
          const receivedCode = url.searchParams.get('code')
          if (error !== null || receivedCode === null) {
            respondHtml(res, 'Sign-in was cancelled. You can close this tab.')
            code.reject(new AiRouteAccountError('denied', url.searchParams.get('error_description') ?? error ?? 'denied'))
            return
          }
          attempt.callback = res
          code.resolve(receivedCode)
        },
      }), 'ai-route-account: browser callback')
      const authorize = new URL('/oauth/authorize', this.origin)
      authorize.searchParams.set('response_type', 'code')
      authorize.searchParams.set('client_id', this.clientId)
      authorize.searchParams.set('redirect_uri', redirectUri)
      authorize.searchParams.set('code_challenge', challenge)
      authorize.searchParams.set('code_challenge_method', 'S256')
      authorize.searchParams.set('state', state)
      authorize.searchParams.set('scope', 'chat models usage')
      authorize.searchParams.set('device_name', hostname().slice(0, 60))
      this.update(attempt, { phase: 'waiting-browser', authorizeUrl: authorize.href })
      const receivedCode = await code.promise
      signal.throwIfAborted()
      this.update(attempt, { phase: 'exchanging' })
      const token = await this.tokenRequest({
        grant_type: 'authorization_code', code: receivedCode, code_verifier: verifier, redirect_uri: redirectUri, client_id: this.clientId,
      }, signal)
      let username: string | null = null
      try {
        const usage = await this.fetchJson<AiRouteUsage>(`${this.baseURL}/me/usage`, token.access_token, signal)
        username = usage.user.username
      } catch {
        // The grant is valid even when the first usage read fails; the UI reads it again.
      }
      const grant = this.grantOf(token, username)
      await this.ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: grant }))
      this.update(attempt, { phase: 'succeeded' })
      if (attempt.callback !== undefined) {
        respondHtml(attempt.callback, 'Signed in to AI Route. You can close this tab and return to the app.')
      }
    } catch (error) {
      if (attempt.callback !== undefined && !attempt.callback.headersSent) {
        respondHtml(attempt.callback, 'Sign-in failed. Close this tab and try again in the app.')
      }
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  // ---------- grant ----------

  private grantOf(token: z.infer<typeof tokenResponse>, username: string | null): Grant {
    const now = Date.now()
    return {
      version: 1,
      issuer: this.origin,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessExpiresAt: now + token.expires_in * 1000,
      refreshExpiresAt: now + 90 * 86_400_000,
      username,
    }
  }

  private async readGrant(): Promise<Grant | undefined> {
    return parseGrant(await this.ctx.credentials.readRecord(KEY), this.origin)
  }

  /**
   * A valid access token for the configured origin, refreshed when it is about to expire.
   * @param url - request destination; tokens are only released to the configured origin.
   * @returns the token, or undefined when signed out.
   */
  async accessToken(url: string = this.baseURL): Promise<string | undefined> {
    let destination: URL
    try { destination = new URL(url) }
    catch { return undefined }
    if (destination.origin !== this.origin || destination.username || destination.password) return undefined
    const grant = await this.readGrant()
    if (grant === undefined) return undefined
    if (grant.accessExpiresAt - Date.now() > 60_000) return grant.accessToken
    this.refreshing ??= this.refresh().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  private async refresh(): Promise<string | undefined> {
    let token: string | undefined
    let invalid = false
    await this.ctx.credentials.modifyRecord(KEY, async (current) => {
      const grant = parseGrant(current, this.origin)
      if (grant === undefined) return undefined
      // Another process may have rotated the token while this one waited for the lock.
      if (grant.accessExpiresAt - Date.now() > 60_000) { token = grant.accessToken; return undefined }
      if (grant.refreshExpiresAt < Date.now()) { invalid = true; return undefined }
      try {
        const next = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: grant.refreshToken, client_id: this.clientId })
        const rotated = this.grantOf(next, grant.username)
        token = rotated.accessToken
        return { kind: 'grant', payload: rotated }
      } catch (error) {
        if (error instanceof AiRouteAccountError && error.code === 'denied') invalid = true
        return undefined
      }
    })
    if (invalid) {
      await this.ctx.credentials.deleteRecord(KEY)
      this.changed()
    }
    return token
  }

  /**
   * Drop the grant after the server rejected its access token (HTTP 401), unless it was already rotated.
   * @param token - the rejected access token.
   */
  async rejectToken(token: string): Promise<void> {
    const grant = await this.readGrant()
    if (grant?.accessToken !== token) return
    const refreshed = await this.accessToken()
    if (refreshed !== undefined && refreshed !== token) return
    await this.ctx.credentials.deleteRecord(KEY)
    this.changed()
  }

  /** Revoke the grant at the server (best effort) and delete it locally. */
  async signOut(): Promise<AiRouteAccountView> {
    await this.cancelSignIn()
    const grant = await this.readGrant()
    await this.ctx.credentials.deleteRecord(KEY)
    this.changed()
    if (grant !== undefined) {
      void fetch(`${this.origin}/api/oauth/revoke`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: grant.refreshToken }).toString(),
        signal: AbortSignal.timeout(this.requestTimeout),
      }).catch(() => undefined)
    }
    return this.getState()
  }

  // ---------- account reads ----------

  /** @returns usage in credits and tokens, or null when signed out. */
  async getUsage(): Promise<AiRouteUsage | null> {
    const token = await this.accessToken()
    if (token === undefined) return null
    return this.authorized(token, () => this.fetchJson<AiRouteUsage>(`${this.baseURL}/me/usage`, token))
  }

  /** @returns the models the signed-in plan includes, in server order; empty when signed out. */
  async listModels(): Promise<AiRouteModel[]> {
    const token = await this.accessToken()
    if (token === undefined) return []
    const body = await this.authorized(token, () => this.fetchJson<{ data: Partial<AiRouteModel>[] }>(`${this.baseURL}/models`, token))
    return (body.data ?? []).filter(m => typeof m.id === 'string').map(m => ({
      id: m.id as string,
      name: typeof m.name === 'string' && m.name.length > 0 ? m.name : (m.id as string),
      context_length: typeof m.context_length === 'number' ? m.context_length : 0,
      tags: Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === 'string') : [],
      free: m.free === true,
      uncensored: m.uncensored === true || (Array.isArray(m.tags) && m.tags.includes('uncensored')),
    }))
  }

  private async authorized<T>(token: string, read: () => Promise<T>): Promise<T> {
    try {
      return await read()
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) await this.rejectToken(token)
      throw error
    }
  }

  /** The request deadline, joined with the caller's signal when one is given. */
  private deadline(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.requestTimeout)
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  }

  private async fetchJson<T>(url: string, token: string, signal?: AbortSignal): Promise<T> {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error',
      signal: this.deadline(signal),
    })
    if (!res.ok) throw new HttpError(res.status, (await res.text().catch(() => '')).slice(0, 500))
    return await res.json() as T
  }

  private async tokenRequest(params: Record<string, string>, signal?: AbortSignal): Promise<z.infer<typeof tokenResponse>> {
    let res: Response
    try {
      res = await fetch(`${this.origin}/api/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(params).toString(),
        redirect: 'error',
        signal: this.deadline(signal),
      })
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      throw new AiRouteAccountError('network', error instanceof Error ? error.message : 'network error')
    }
    const text = await res.text()
    if (!res.ok) {
      let code = 'token_error'
      try { code = String((JSON.parse(text) as { error?: unknown }).error ?? code) } catch { /* not JSON */ }
      if (code === 'invalid_grant' || code === 'invalid_client') throw new AiRouteAccountError('denied', code)
      throw new AiRouteAccountError('protocol', `token endpoint ${res.status} ${code}`)
    }
    const parsed = tokenResponse.safeParse(JSON.parse(text))
    if (!parsed.success) throw new AiRouteAccountError('protocol', 'malformed token response')
    return parsed.data
  }
}
export default AiRouteAccount

class HttpError extends Error {
  constructor(readonly status: number, body: string) { super(`HTTP ${status}${body ? `: ${body}` : ''}`) }
}

function parseGrant(record: CredentialRecord | undefined, origin: string): Grant | undefined {
  if (record?.kind !== 'grant') return undefined
  const parsed = grantSchema.safeParse(record.payload)
  if (!parsed.success || parsed.data.issuer !== origin) return undefined
  return parsed.data
}

function isActive(phase: AiRouteSignInAttempt['phase']): boolean {
  return phase === 'waiting-browser' || phase === 'exchanging'
}

function isLoopback(url: URL): boolean {
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
}

/** Accept only a bare loopback HTTP origin for the browser callback. */
function loopbackOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) }
  catch { throw new AiRouteAccountError('protocol', 'callbackOrigin must be a URL') }
  const bare = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password
  if (url.protocol !== 'http:' || !isLoopback(url) || !bare) {
    throw new AiRouteAccountError('protocol', 'callbackOrigin must be a loopback http origin')
  }
  return url.origin
}

function respondHtml(res: ServerResponse, message: string): void {
  if (res.headersSent) return
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
  }).end('<!doctype html><html lang="en"><meta charset="utf-8"><title>AI Route</title>'
    + '<body style="font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;'
    + 'justify-content:center;margin:0;background:#f6f6f7;color:#111">'
    + `<p style="font-size:15px">${escapeHtml(message)}</p></body></html>`)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}
