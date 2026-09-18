/**
 * Host half of dsh-token-dashboard.
 *
 * The dashboard is a pure browser surface: it reads the `tokenUsage` and
 * `contextPressure` session projections that `@deepseek-ai/dsh-token-meter`
 * already computes and serves to every client. Nothing needs to run in the
 * dsh process, so this plugin is deliberately inert — it exists so the Loader
 * holds an enabled entry for the package, which is what makes
 * `@deepseek-ai/dsh-client-modules` scan `dsh.client` and serve
 * `lib/client.js` to the page.
 *
 * It registers no tools, no services, and no model-visible content.
 *
 * @module dsh-token-dashboard
 */

/** Stable Cordis plugin name. */
export const name = 'dsh-token-dashboard';

/** No host services are required: the host half observes nothing. */
export const inject = [];

/**
 * Keep the loader entry alive without contributing host behavior.
 *
 * `apply` must exist (the Loader treats a plugin module without it as
 * malformed), but an empty body is the honest implementation: the browser
 * half is loaded from the boot graph, not from here.
 */
export function apply() {}
