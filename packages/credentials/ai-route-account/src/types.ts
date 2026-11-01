/**
 * Client-safe type surface of the AI Route account seam. Types only: the Remote controller and the
 * settings UI read exactly these shapes, and no token or PKCE secret ever appears in them.
 * @module @deepseek-ai/dsh-ai-route-account/types
 */

/** Phase of the one local browser sign-in attempt. */
export type AiRouteSignInPhase = 'waiting-browser' | 'exchanging' | 'succeeded' | 'cancelled' | 'expired' | 'failed'

/** The attempt as the UI may see it. */
export interface AiRouteSignInAttempt {
  phase: AiRouteSignInPhase
  /** Authorization page to open in the system browser while `waiting-browser`. */
  authorizeUrl?: string
  /** Epoch milliseconds after which the attempt expires. */
  expiresAt?: number
  /** Short machine-readable reason for `failed`. */
  error?: string
}

/** Stored-account presence and the latest attempt; never carries credentials. */
export interface AiRouteAccountView {
  status: 'signed-out' | 'signed-in'
  /** Username of the signed-in account, when known. */
  username: string | null
  /** Where the dashboard lives (sign-in, keys, usage pages). */
  dashboardUrl: string
  attempt: AiRouteSignInAttempt | null
}

/** One allowance window from `GET /me/usage`. Credits only: 1 credit = 0.001 USD; no dollar amounts. */
export interface AiRouteAllowanceWindow {
  label: string
  window_ms: number
  used_credits: number
  /** null = this plan has no limit for the window (the UI hides the bar). */
  limit_credits: number | null
  remaining_credits: number | null
  percent: number | null
  /** ISO time when the oldest charge ages out, i.e. when allowance starts freeing up; null when nothing is in the window. */
  resets_at: string | null
  tokens: number
  prompt_tokens: number
  completion_tokens: number
  requests: number
}

export interface AiRouteUsageTotal {
  credits: number
  tokens: number
  requests: number
}

/** `GET /api/v1/me/usage` response. */
export interface AiRouteUsage {
  user: { username: string }
  key: { name: string }
  plan: { name: string; includes_auto: boolean; rpm_limit: number | null } | null
  credit_usd: number
  allowance: { five_hour: AiRouteAllowanceWindow; weekly: AiRouteAllowanceWindow }
  totals: { today: AiRouteUsageTotal; this_week: AiRouteUsageTotal; this_month: AiRouteUsageTotal }
  generated_at: string
}

/** One entry of `GET /api/v1/models`, in the order the server wants it listed. */
export interface AiRouteModel {
  id: string
  name: string
  context_length: number
  /** Display hints such as `recommended`, `uncensored`, `free`. */
  tags: string[]
  free: boolean
  uncensored: boolean
}
