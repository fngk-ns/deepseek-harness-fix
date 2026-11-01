/** Authenticated Remote operations for the AI Route account UI. */
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-ai-route-account'
import type { AiRouteAccountView, AiRouteModel, AiRouteUsage } from '@deepseek-ai/dsh-ai-route-account/types'

/** AI Route account commands and the reconnect-safe state stream. */
export class AiRouteController extends TypertRemoteService {
  static inject = ['aiRouteAccount']
  /** @param ctx - Host with the AI Route account service mounted. */
  constructor(ctx: Context) { super(ctx, 'aiRouteController', { namespace: 'aiRoute' }) }
  /**
   * Read the safe account projection.
   * @returns stored-account presence and the current attempt.
   */
  @Remote
  getState(): Promise<AiRouteAccountView> { return this.ctx.aiRouteAccount.getState() }
  /**
   * Begin browser sign-in.
   * @param callbackOrigin - browser-accessible loopback HTTP origin of this Host.
   * @returns the new or already-active attempt.
   */
  @Remote
  startSignIn(callbackOrigin: string): Promise<AiRouteAccountView> { return this.ctx.aiRouteAccount.startSignIn(callbackOrigin) }
  /**
   * Cancel the active attempt.
   * @returns state after cancellation.
   */
  @Remote
  cancelSignIn(): Promise<AiRouteAccountView> { return this.ctx.aiRouteAccount.cancelSignIn() }
  /**
   * Revoke the grant and remove it locally.
   * @returns state after sign-out.
   */
  @Remote
  signOut(): Promise<AiRouteAccountView> { return this.ctx.aiRouteAccount.signOut() }
  /**
   * Read allowance usage in credits and tokens.
   * @returns usage, or null when signed out.
   */
  @Remote
  getUsage(): Promise<AiRouteUsage | null> { return this.ctx.aiRouteAccount.getUsage() }
  /**
   * Read the models the signed-in plan includes.
   * @returns models in server order; empty when signed out.
   */
  @Remote
  listModels(): Promise<AiRouteModel[]> { return this.ctx.aiRouteAccount.listModels() }
  /**
   * Stream the safe account projection.
   * @param signal - stream lifetime.
   * @returns initial snapshot and subsequent changes.
   */
  @Remote({ mode: 'stream' })
  watch(signal: AbortSignal): AsyncIterable<AiRouteAccountView> { return this.ctx.aiRouteAccount.watch(signal) }
}
export default AiRouteController
