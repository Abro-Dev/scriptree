/**
 * The address people should use to reach ScripTree: printed on sign-in slips and used as the return
 * address for invite and password-reset emails. Set VITE_SITE_URL in production (https://scriptree.dev)
 * so links never point at a preview deployment; locally it falls back to wherever the app is running.
 */
export const SITE_URL: string = ((import.meta.env.VITE_SITE_URL as string | undefined)?.trim()
  || (typeof window === 'undefined' ? '' : window.location.origin)).replace(/\/+$/, '');
