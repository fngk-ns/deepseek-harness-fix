/** Host half of the AI Route settings client: nothing to configure; the browser half lives in `./client`. */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'ui-settings-ai-route'

/** @param _ctx - Host context; the plugin only ships its browser bundle. */
export function apply(_ctx: Context): void {}
