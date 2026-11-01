/** AI Route settings: sign-in actions, allowance usage in credits, and the plan's model list. */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AiRouteAccountView, AiRouteAllowanceWindow, AiRouteModel, AiRouteUsage } from '@deepseek-ai/dsh-ai-route-account/types'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './AiRouteSection.module.css'

/** Safe account snapshot shared with the settings page. */
export interface AiRouteSnapshot {
  /** Latest Host state, absent until the stream responds. */
  view: AiRouteAccountView | undefined
  /** Latest usage read; null when signed out, absent while loading. */
  usage: AiRouteUsage | null | undefined
  /** Latest model listing, absent while loading. */
  models: AiRouteModel[] | undefined
  /** Whether the state stream or the last read failed. */
  failed: boolean
  /** The user's language, for number and time formatting. */
  language: string
}

/** Host operations injected into the Cordis-free component. */
export interface AiRouteSectionInjected {
  hooks: { account: HostObservable<AiRouteSnapshot> }
  /** Begin browser sign-in and open the authorization page. */
  start: () => Promise<void>
  cancel: () => Promise<void>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
  /** Open a URL in the system browser. */
  openUrl: (url: string) => void
}

export type AiRouteSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<'settings.ai-route'> & InjectFace<AiRouteSectionInjected>

/** @param props - localized actions and the account subscription. @returns the AI Route settings UI. */
export function AiRouteSection({ t, useAccount, start, cancel, signOut, refresh, openUrl }: AiRouteSectionProps) {
  const { view, usage, models, failed, language } = useAccount(value => value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const attempt = view?.attempt
  const active = attempt !== null && attempt !== undefined && (attempt.phase === 'waiting-browser' || attempt.phase === 'exchanging')
  const signedIn = view?.status === 'signed-in'
  const fill = (text: string, values: Record<string, string>) =>
    Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, value), text)
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(false)
    try { await action() } catch { setError(true) } finally { setBusy(false) }
  }
  const attemptStatus = attempt?.phase === 'waiting-browser' ? t('waiting')
    : attempt?.phase === 'exchanging' ? t('exchanging')
      : attempt?.phase === 'expired' ? t('expired')
        : attempt?.phase === 'cancelled' ? t('cancelled')
          : attempt?.phase === 'failed' ? t('failed') : undefined

  if (!signedIn) {
    return (
      <section className={css.section} aria-label={t('nav')}>
        <div className={css.card}>
          <div className={css.header}>
            <div className={css.identity}>
              <span className={css.name}>{t('signedOutTitle')}</span>
              <span className={error || failed ? css.error : css.status} role="status">
                {error || failed ? t('failed') : attemptStatus ?? t('signedOutDescription')}
              </span>
            </div>
            <div className={css.actions}>
              {active && attempt.authorizeUrl !== undefined && (
                <Button variant="outline" onClick={() => { openUrl(attempt.authorizeUrl ?? '') }}>{t('openBrowser')}</Button>
              )}
              {active
                ? (
                  <Button variant="outline" disabled={busy || attempt.phase === 'exchanging'} onClick={() => { void run(cancel) }}>
                    {t('cancel')}
                  </Button>
                )
                : (
                  <Button variant="primary" disabled={busy || view === undefined} onClick={() => { void run(start) }}>
                    {t('signIn')}
                  </Button>
                )}
            </div>
          </div>
        </div>
      </section>
    )
  }

  const plan = usage?.plan
  return (
    <section className={css.section} aria-label={t('nav')}>
      <div className={css.card}>
        <div className={css.header}>
          <div className={css.identity}>
            <span className={css.name}>{usage?.user.username ?? view.username ?? t('signedIn')}</span>
            <span className={css.status} role="status">
              {error || failed ? <span className={css.error}>{t('failed')}</span>
                : usage === undefined ? t('loading')
                  : `${t('plan')} · ${plan?.name ?? t('noPlan')}`}
            </span>
          </div>
          <div className={css.actions}>
            <a className={css.link} href={view.dashboardUrl} target="_blank" rel="noopener noreferrer"
              onClick={(event) => { event.preventDefault(); openUrl(view.dashboardUrl) }}>{t('dashboard')}</a>
            <Button variant="ghost" disabled={busy} onClick={() => { void run(refresh) }}>{t('refresh')}</Button>
            <Button variant="outline" disabled={busy} onClick={() => { void run(signOut) }}>{t('signOut')}</Button>
          </div>
        </div>
      </div>

      <div className={css.card}>
        <div className={css.row}>
          <span className={css.title}>{t('usageTitle')}{plan ? ` · ${plan.name}` : ''}</span>
        </div>
        {usage === undefined && <span className={css.status}>{t('loading')}</span>}
        {usage != null && (
          <>
            {usage.allowance.five_hour.limit_credits !== null && (
              <Limit label={t('fiveHour')} window={usage.allowance.five_hour} language={language} t={t} fill={fill} />
            )}
            <Limit label={t('weekly')} window={usage.allowance.weekly} language={language} t={t} fill={fill} />
            <div className={css.divider} />
            <div className={css.row}>
              <span className={css.muted}>{t('tokensToday')}</span>
              <span className={css.percent}>
                {formatCount(usage.totals.today.tokens, language)} {t('tokens')}
                {' · '}{formatCount(usage.totals.today.requests, language)} {t('requests')}
              </span>
            </div>
            <div className={css.row}>
              <span className={css.muted}>{t('tokensWeek')}</span>
              <span className={css.percent}>
                {formatCount(usage.totals.this_week.tokens, language)} {t('tokens')}
                {' · '}{formatCount(usage.totals.this_week.requests, language)} {t('requests')}
              </span>
            </div>
          </>
        )}
      </div>

      <div className={css.card}>
        <div className={css.row}><span className={css.title}>{t('modelsTitle')}</span></div>
        {models === undefined ? <span className={css.status}>{t('loading')}</span>
          : models.length === 0 ? <span className={css.status}>{t('modelsEmpty')}</span>
            : (
              <ul className={css.models}>
                {models.map(model => (
                  <li key={model.id} className={css.model}>
                    <span className={css.modelName}>
                      <span>{model.name}</span>
                      {model.uncensored && <Shield title={t('uncensored')} />}
                      {model.free && <span className={`${css.tag} ${css.tagFree}`}>{t('free')}</span>}
                    </span>
                    <span className={css.modelId}>{model.id}</span>
                  </li>
                ))}
              </ul>
            )}
      </div>
    </section>
  )
}

interface LimitProps {
  label: string
  window: AiRouteAllowanceWindow
  language: string
  t: AiRouteSectionProps['t']
  fill: (text: string, values: Record<string, string>) => string
}

/** One allowance window row: label, reset time, percent, and a bar; unlimited windows show only the spend. */
function Limit({ label, window: w, language, t, fill }: LimitProps) {
  const percent = w.percent ?? 0
  const tone = percent >= 90 ? css.fillDanger : percent >= 70 ? css.fillWarn : ''
  const reset = w.resets_at === null ? undefined : fill(t('resetAt'), { time: formatReset(w.resets_at, language) })
  return (
    <div className={css.limit}>
      <div className={css.limitHead}>
        <span>{label}</span>
        <span className={css.limitMeta}>
          {w.limit_credits === null
            ? <span>{t('unlimited')} · {fill(t('creditsUsed'), { used: formatCount(w.used_credits, language) })}</span>
            : (
              <>
                {reset !== undefined && <span>{reset}</span>}
                <span className={css.percent}
                  title={fill(t('creditsOf'), {
                    used: formatCount(w.used_credits, language), limit: formatCount(w.limit_credits, language),
                  })}>
                  {Math.round(percent)}%
                </span>
              </>
            )}
        </span>
      </div>
      {w.limit_credits !== null && (
        <div className={css.bar} role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
          <div className={`${css.fill} ${tone}`} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
        </div>
      )}
    </div>
  )
}

function Shield({ title }: { title: string }) {
  return (
    <span className={css.shield} title={title} aria-label={title}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 2 4 5v6c0 5.25 3.4 10.15 8 11.45C16.6 21.15 20 16.25 20 11V5l-8-3z" />
      </svg>
    </span>
  )
}

function formatCount(value: number, language: string): string {
  try { return new Intl.NumberFormat(language, { maximumFractionDigits: value < 10 ? 2 : 0 }).format(value) }
  catch { return String(Math.round(value)) }
}

/** "10:50 PM" today, or with the weekday when the reset is more than a day away. */
function formatReset(iso: string, language: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const farAway = date.getTime() - Date.now() > 24 * 60 * 60 * 1000
  try {
    return new Intl.DateTimeFormat(language, {
      hour: 'numeric', minute: '2-digit', ...farAway ? { weekday: 'short' } : {},
    }).format(date)
  } catch {
    return date.toLocaleTimeString()
  }
}
