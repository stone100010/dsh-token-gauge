window.__ModuleLoader__.load({
	id: "@stone100010/dsh-token-gauge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_cordis = require("@deepseek-ai/cordis");
		let _deepseek_ai_dsh_api_session_controller_client = require("@deepseek-ai/dsh-api-session-controller/client");
		let _deepseek_ai_dsh_client_ui_slots = require("@deepseek-ai/dsh-client-ui-slots");
		let react = require("react");

		//#region lib/types/client/meta.js
		/**
		 * Real-time token meter for the DSH Web GUI.
		 *
		 * A draggable floating panel on the frame-wide `shell.overlay` seat, laid
		 * out as three instrument dials: cumulative token usage, throughput in
		 * tok/s, and estimated cost against a budget — plus a throughput trace and
		 * a request counter.
		 *
		 * Every figure comes from host-computed session projections the page
		 * already receives (`tokenUsage`, `contextPressure`, `contextBreakdown`,
		 * `sessionStats`), so the panel adds no session events, no tools, and no
		 * model-visible content.
		 */

		/** Cordis plugin name. */
		const name = "token-dashboard";

		/** `slots` is the composition registry; `sessions` is the projection source. */
		const inject = ["slots", "sessions"];

		/** SlotMap key this panel occupies (a frame-wide, click-through list seat). */
		const SLOT = "shell.overlay";

		/** Stable list cell id. */
		const SLOT_ID = "dsh-token-gauge";

		/** LocalStorage keys for remembered panel state. */
		const STORAGE_KEY = "dsh-token-gauge.panel.v2";
		const COLLAPSED_KEY = "dsh-token-gauge.collapsed.v2";
		const SIZE_KEY = "dsh-token-gauge.size.v1";

		/** Edge gap kept when clamping the panel inside the viewport. */
		const MARGIN = 8;

		/** Default and minimum panel geometry (px). */
		const DEFAULT_W = 480;
		const DEFAULT_H = 212;
		const MIN_W = 436;
		const MIN_H = 186;
		const MIN_VISIBLE = 44;

		/** How long to wait before re-resolving a projection route that threw. */
		const RETRY_MS = 1500;

		/** Throughput sampling cadence. */
		const SAMPLE_MS = 1000;

		/**
		 * Dial scales. These are the user's real-world ranges, and the reading
		 * itself is the alarm: 300M cumulative tokens means the model is burning
		 * context, 500 tok/s means it has become erratic, and $12 means the budget
		 * is gone. The warning bands sit below each limit.
		 */
		const SCALE_TOKENS = 300e6;
		const SCALE_RATE = 500;
		const SCALE_COST = 12;
		const BUDGET_USD = SCALE_COST;
		const ZONES = { tokens: [0.5, 0.8], rate: [0.6, 0.84], cost: [0.5, 0.8] };

		/**
		 * Reference pricing in USD per million tokens.
		 *
		 * `deepseek-v4.1-flash` is absent from the installed pi-ai catalog, so DSH
		 * computes no cost for it and there is no per-session cost projection to
		 * read. These figures mirror the catalog's `deepseek` family entry and are
		 * therefore an ESTIMATE, not this gateway's invoice; the dial says so.
		 */
		const PRICES = {
			uncachedInput: 0.14,
			cacheRead: 0.0028,
			cacheWrite: 0.14,
			output: 0.28
		};
		//#endregion

		//#region lib/types/client/format.js
		/** Power-of-ten suffixes, index = floor(log1000). */
		const SCALES = ["", "K", "M", "B", "T"];

		/**
		 * Round for display, immune to binary representation error.
		 *
		 * `(26.95).toFixed(1)` returns "26.9" because 26.95 is stored as
		 * 26.949999999999999; the same trap turns 1.005 into "1.00". Nudging by a
		 * few ULPs before rounding fixes every such case, which matters here because
		 * a headline that rounds down while its own parts round up looks broken.
		 * @param value - the number to format.
		 * @param decimals - decimal places to keep.
		 * @returns the formatted string.
		 */
		function fixed(value, decimals) {
			const factor = Math.pow(10, decimals);
			const nudge = Number.EPSILON * Math.max(1, Math.abs(value)) * 4;
			return (Math.round((value + nudge) * factor) / factor).toFixed(decimals);
		}

		/**
		 * Compact a count for a headline figure (`123M`, `213.6K`).
		 * @param n - number.
		 * @returns display string; em dash when not finite.
		 */
		function abbr(n) {
			if (!Number.isFinite(n)) return "—";
			const v = Math.max(0, n);
			if (v < 1000) return v < 100 && !Number.isInteger(v) ? fixed(v, 1) : String(Math.round(v));
			// Scale first and choose precision from the SCALED magnitude: rounding
			// before scaling (27837 -> 28000 -> "28K") makes a part sum contradict the
			// headline beside it.
			let tier = 0;
			let scaled = v;
			while (scaled >= 1000 && tier < SCALES.length - 1) {
				scaled /= 1000;
				tier += 1;
			}
			return fixed(scaled, scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2) + SCALES[tier];
		}

		/**
		 * Split a compacted count into numeric part and unit suffix so a dial can
		 * render them at different sizes (`123` + `M`).
		 * @param n - number.
		 * @returns the parts; `unit` is empty below 1000.
		 */
		function splitAbbr(n) {
			// Sub-unit values (an estimated cost of $0.0014) need significant digits
			// rather than the compact integer path, or the dial reads "0.0".
			if (Number.isFinite(n) && n > 0 && n < 1) {
				// Enough decimals to keep two significant digits ("0.03", "0.0014")
				// without overflowing the dial: a fixed two decimals rounds a sub-cent
				// estimate to a flat "0.00", which reads as broken.
				const decimals = Math.min(6, Math.max(2, 2 - Math.floor(Math.log10(n)) - 1));
				const text = fixed(n, decimals);
				// Trim trailing zeros but never below the two-decimal money shape:
				// "0.03" rather than "0.030", "0.0014" rather than "0.00140".
				const trimmed = text.includes(".") ? text.replace(/0+$/, "") : text;
				const tidy =
					trimmed.includes(".") && trimmed.split(".")[1].length >= 2
						? trimmed
						: text.slice(0, text.indexOf(".") + 3);
				return { value: tidy, unit: "" };
			}
			const text = abbr(n);
			const match = /^([\d.]+)(.*)$/.exec(text);
			return match ? { value: match[1], unit: match[2] } : { value: text, unit: "" };
		}

		/**
		 * Group digits for an exact count.
		 * @param n - number.
		 * @returns grouped string, or an em dash when not finite.
		 */
		function exact(n) {
			if (!Number.isFinite(n)) return "—";
			return Math.round(n).toLocaleString("en-US");
		}

		/**
		 * Render a USD amount, with extra precision below one cent.
		 * @param usd - amount in dollars.
		 * @returns display string, or an em dash when not finite.
		 */
		function money(usd) {
			if (!Number.isFinite(usd)) return "—";
			// Cents normally; significant digits while the amount is small enough
			// that two decimals would round it to a flat $0.00 and look broken.
			const decimals = usd === 0 || Math.abs(usd) >= 0.01 ? 2 : 2 - Math.floor(Math.log10(Math.abs(usd))) - 1;
			return "$" + fixed(usd, Math.min(6, Math.max(2, decimals)));
		}

		/**
		 * Format a duration as a compact clock.
		 * @param ms - milliseconds.
		 * @returns `1h02m`, `3m04s`, `12s`, or an em dash.
		 */
		function duration(ms) {
			if (!Number.isFinite(ms) || ms <= 0) return "—";
			const total = Math.round(ms / 1000);
			const h = Math.floor(total / 3600);
			const m = Math.floor((total % 3600) / 60);
			const s = total % 60;
			const pad = (v) => String(v).padStart(2, "0");
			if (h) return h + "h" + pad(m) + "m";
			if (m) return m + "m" + pad(s) + "s";
			return s + "s";
		}
		//#endregion

		//#region lib/types/client/geometry.js
		/** Default anchor: bottom-right, the least intrusive corner for a live meter. */
		function defaultPos(size) {
			const w = typeof window === "undefined" ? 1280 : window.innerWidth;
			const h = typeof window === "undefined" ? 800 : window.innerHeight;
			return { x: Math.max(MARGIN, w - size.w - 24), y: Math.max(MARGIN, h - size.h - 24) };
		}

		/**
		 * Keep the panel grabbable: its header always stays inside the viewport.
		 * @param pos - candidate position.
		 * @param size - current panel size.
		 * @returns clamped position.
		 */
		function clamp(pos, size) {
			if (typeof window === "undefined") return pos;
			const width = (size && size.w) || DEFAULT_W;
			return {
				x: Math.min(Math.max(MARGIN, pos.x), Math.max(MARGIN, window.innerWidth - Math.min(width, MIN_W))),
				y: Math.min(Math.max(MARGIN, pos.y), Math.max(MARGIN, window.innerHeight - MIN_VISIBLE))
			};
		}

		/** @returns the remembered panel size, bounded to the viewport. */
		function loadSize() {
			const maxW = typeof window === "undefined" ? DEFAULT_W : Math.max(MIN_W, window.innerWidth - MARGIN * 2);
			try {
				const parsed = JSON.parse(window.localStorage.getItem(SIZE_KEY) || "null");
				if (parsed && Number.isFinite(parsed.w) && Number.isFinite(parsed.h)) {
					return { w: Math.min(Math.max(MIN_W, parsed.w), maxW), h: Math.max(MIN_H, parsed.h) };
				}
			} catch {}
			return { w: Math.min(DEFAULT_W, maxW), h: DEFAULT_H };
		}

		/**
		 * Persist the panel size.
		 * @param size - size to store.
		 */
		function saveSize(size) {
			try {
				window.localStorage.setItem(SIZE_KEY, JSON.stringify(size));
			} catch {}
		}

		/** @returns the remembered position, or the default anchor. */
		function loadPos(size) {
			try {
				const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
				if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) return clamp(parsed, size);
			} catch {}
			return defaultPos(size);
		}

		/**
		 * Persist the position. A storage failure is non-fatal: the panel keeps
		 * working, it just forgets where it was.
		 * @param pos - position to store.
		 */
		function savePos(pos) {
			try {
				window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pos));
			} catch {}
		}

		/** @returns whether the collapsed state was remembered. */
		function loadCollapsed() {
			try {
				return window.localStorage.getItem(COLLAPSED_KEY) === "1";
			} catch {
				return false;
			}
		}

		/**
		 * Persist the collapsed state.
		 * @param value - collapsed flag.
		 */
		function saveCollapsed(value) {
			try {
				window.localStorage.setItem(COLLAPSED_KEY, value ? "1" : "0");
			} catch {}
		}
		//#endregion

		//#region lib/types/client/meter.js
		/** Zeroed usage, used while the projection is still absent. */
		const EMPTY_TOTALS = {
			uncachedInputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0
		};

		/** Zeroed session stats, used while the projection is still absent. */
		const EMPTY_STATS = { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, decodeMs: 0, decodeTokens: 0 };

		/**
		 * Normalize the `tokenUsage` projection to its four buckets.
		 *
		 * The host's wire view publishes the buckets FLAT (`view: state => state.totals`),
		 * so `usage.uncachedInputTokens` is the real shape and `usage.totals` only
		 * exists on the host-side state. Reading the nested path alone silently
		 * yields zeros, which is exactly the bug this guard exists to prevent.
		 * @param usage - the projection value, in either shape.
		 * @returns the four buckets.
		 */
		function tokenBuckets(usage) {
			if (!usage) return EMPTY_TOTALS;
			const source = usage.totals || usage;
			if (!Number.isFinite(source.uncachedInputTokens) && !Number.isFinite(source.outputTokens)) return EMPTY_TOTALS;
			return {
				uncachedInputTokens: source.uncachedInputTokens || 0,
				outputTokens: source.outputTokens || 0,
				cacheReadTokens: source.cacheReadTokens || 0,
				cacheWriteTokens: source.cacheWriteTokens || 0
			};
		}

		/**
		 * Estimated USD for one usage snapshot.
		 * @param totals - the four disjoint token buckets.
		 * @returns the estimated cost in dollars.
		 */
		function estimateCost(totals) {
			return (
				(totals.uncachedInputTokens * PRICES.uncachedInput +
					totals.cacheReadTokens * PRICES.cacheRead +
					totals.cacheWriteTokens * PRICES.cacheWrite +
					totals.outputTokens * PRICES.output) /
				1e6
			);
		}

		/**
		 * Session-average decode throughput — the provider-anchored figure DSH
		 * itself records, independent of how long this page has been open.
		 * @param stats - the sessionStats projection.
		 * @returns tokens per second, or undefined when nothing has decoded yet.
		 */
		function sessionRate(stats) {
			if (!stats || !Number.isFinite(stats.decodeMs) || !Number.isFinite(stats.decodeTokens)) return undefined;
			if (stats.decodeMs <= 0 || stats.decodeTokens <= 0) return undefined;
			return stats.decodeTokens / (stats.decodeMs / 1000);
		}

		/**
		 * Turn a bare observable into a React subscription.
		 *
		 * The face's identity is the subscription identity, so deriving the
		 * subscribe/getSnapshot pair from the face is what makes a session switch
		 * invalidate the cached snapshot immediately instead of showing the
		 * previous session's figures until the new face happens to notify.
		 * @param face - observable snapshot, or null while unresolved.
		 * @returns the current value (`undefined` when the capability is absent).
		 */
		function useFaceValue(face) {
			const store = react.useMemo(
				() => ({
					subscribe: (onChange) => (face ? face.subscribe(onChange) : () => {}),
					get: () => (face ? face.getSnapshot() : undefined)
				}),
				[face]
			);
			return react.useSyncExternalStore(store.subscribe, store.get, () => undefined);
		}

		/**
		 * Resolve a session's projection face through every public route the
		 * session service offers, most direct first.
		 *
		 * `binding()` is the plain accessor and needs no agent scope; `scope()`
		 * plus `sessionOf()` is the older two-step route and yields nothing
		 * whenever the host has not materialized a scope for the session. Trying
		 * both keeps the panel alive across compositions, and the route that won
		 * is reported in the panel header so a failure is visible rather than
		 * silent.
		 * @param sessions - the `ctx.sessions` service instance.
		 * @param sessionId - current session id, or undefined.
		 * @param key - projection key.
		 * @returns `{ face, via, failed }`.
		 */
		function resolveFace(sessions, sessionId, key) {
			if (!sessions || sessionId === undefined || sessionId === null) {
				return { face: null, via: "no-session", failed: false };
			}
			let failed = false;
			if (typeof sessions.binding === "function") {
				try {
					const binding = sessions.binding(sessionId);
					const projections = binding && binding.session && binding.session.projections;
					if (projections) return { face: projections.faceOf(key), via: "binding", failed: false };
				} catch {
					failed = true;
				}
			}
			if (typeof sessions.scope === "function" && typeof sessions.sessionOf === "function") {
				try {
					const scoped = sessions.scope(sessionId);
					if (scoped) {
						const sessionFace = sessions.sessionOf(scoped);
						if (sessionFace && sessionFace.projections) {
							return { face: sessionFace.projections.faceOf(key), via: "scope", failed: false };
						}
					}
				} catch {
					failed = true;
				}
			}
			return { face: null, via: "unresolved", failed: failed };
		}

		/**
		 * Resolve one projection face, re-resolving when the session changes.
		 *
		 * Resolution is a synchronous read of the client-side projection store, so
		 * it happens during render: the value and the route that served it are
		 * available immediately, with no second render and no state to go stale.
		 * A route that *threw* is a transient host state, so a retry is scheduled
		 * on a timer — and because the retry bumps a counter that participates in
		 * the memo, the panel recovers on its own. A failed read reports
		 * `resolved: false`, which stops the last snapshot from being displayed as
		 * if it were live.
		 * @param sessions - the `ctx.sessions` service instance.
		 * @param sessionId - current session id, or undefined.
		 * @param key - projection key.
		 * @returns `{ face, via, failed, resolved }`.
		 */
		function useProjectionFace(sessions, sessionId, key) {
			const [attempt, setAttempt] = react.useState(0);
			// Deliberately NOT memoized. Route availability (whether the host has
			// materialized a binding or an agent scope) is not observable, so any
			// cache key would go stale exactly when a route breaks — which is the
			// failure this panel must show rather than hide. Resolution is a cached
			// lookup inside the projection store, so re-reading it per render is
			// cheap; the retry counter only exists to schedule another read.
			const resolved = resolveFace(sessions, sessionId, key);
			void attempt;
			react.useEffect(() => {
				if (!resolved.failed) return undefined;
				const timer = window.setTimeout(() => setAttempt((v) => v + 1), RETRY_MS);
				return () => window.clearTimeout(timer);
			}, [resolved.failed, resolved.via]);
			return {
				face: resolved.face,
				via: resolved.via,
				failed: resolved.failed,
				resolved: resolved.face !== null
			};
		}

		/**
		 * Read every figure the panel shows, from four projections.
		 * @param sessions - the `ctx.sessions` service instance.
		 * @param sessionId - current session id, or undefined.
		 * @returns the live dashboard model.
		 */
		function useTokenModel(sessions, sessionId) {
			const usageFace = useProjectionFace(sessions, sessionId, "tokenUsage");
			const pressureFace = useProjectionFace(sessions, sessionId, "contextPressure");
			const breakdownFace = useProjectionFace(sessions, sessionId, "contextBreakdown");
			const statsFace = useProjectionFace(sessions, sessionId, "sessionStats");

			// Reading through `useFaceValue(face)` alone would keep the LAST snapshot
			// when the face goes away: useSyncExternalStore retains its previous value
			// across a re-subscribe, so a broken route would show stale-but-plausible
			// numbers. Gating on the resolved face makes that state visible instead.
			const usageNode = useFaceValue(usageFace.face);
			const pressureNode = useFaceValue(pressureFace.face);
			const breakdownNode = useFaceValue(breakdownFace.face);
			const statsNode = useFaceValue(statsFace.face);
			const usage = usageFace.resolved ? usageNode : undefined;
			const pressure = pressureFace.resolved ? pressureNode : undefined;
			const breakdown = breakdownFace.resolved ? breakdownNode : undefined;
			const stats = statsFace.resolved ? statsNode : undefined;

			const totals = tokenBuckets(usage);
			const last = (usage && usage.last) || null;
			const cleanStats = stats || EMPTY_STATS;

			// The input side counts everything that entered the prompt. Cache reads
			// dominate a long session and are what make the cumulative figure dwarf
			// the context window.
			const inputTokens = totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
			const outputTokens = totals.outputTokens;

			// Occupancy prefers `projectedTokens` (the next request's prompt cost,
			// which answers a compaction) and falls back to the provider-anchored
			// sample. This host publishes only the latter today.
			const windowSize = pressure && Number.isFinite(pressure.contextWindow) ? pressure.contextWindow : undefined;
			const projected =
				pressure && Number.isFinite(pressure.projectedTokens)
					? pressure.projectedTokens
					: pressure && Number.isFinite(pressure.pressureTokens)
						? pressure.pressureTokens
						: undefined;

			const composition = (breakdown && breakdown.breakdown) || breakdown || null;

			return {
				totals,
				last,
				lastBuckets: (last && last.buckets) || null,
				inputTokens,
				outputTokens,
				totalTokens: inputTokens + outputTokens,
				windowSize,
				projected,
				composition,
				stats: cleanStats,
				cost: estimateCost(totals),
				budget: BUDGET_USD,
				average: sessionRate(cleanStats),
				hasData: usage !== undefined || pressure !== undefined || stats !== undefined,
				via: usageFace.via,
				// A primitive snapshot of every displayed figure: the trace sampler
				// diffs it, and the header shows its first field as a freshness probe.
				signature: [
					totals.uncachedInputTokens,
					totals.cacheReadTokens,
					totals.outputTokens,
					cleanStats.decodeMs,
					cleanStats.decodeTokens,
					cleanStats.steps,
					projected === undefined ? "n" : projected
				].join("|")
			};
		}

		/**
		 * Sample throughput once a second.
		 *
		 * The rate is measured from the projection's own movement — output tokens
		 * gained per elapsed wall time — so it is real page-observed throughput.
		 * While a session is idle (no movement in the last sample) the honest
		 * headline is the session-average decode rate, not zero.
		 * @param model - the current dashboard model.
		 * @returns `{ rate, live }`.
		 */
		function useThroughput(model) {
			const state = react.useRef({ at: 0, out: null, rate: undefined });
			const latest = react.useRef(model);
			const [, force] = react.useState(0);
			latest.current = model;

			react.useEffect(() => {
				const timer = window.setInterval(() => {
					const now = Date.now();
					const samples = state.current;
					const current = latest.current;
					const out = current.outputTokens;
					if (samples.at === 0 || samples.out === null) {
						samples.at = now;
						samples.out = out;
					} else {
						const elapsed = (now - samples.at) / 1000;
						const delta = out - samples.out;
						samples.at = now;
						samples.out = out;
						// A negative delta means a replacement (session switch or
						// compaction): record no measurement rather than negative rate.
						if (elapsed > 0) samples.rate = delta >= 0 ? delta / elapsed : 0;
					}
					force((v) => v + 1);
				}, SAMPLE_MS);
				return () => window.clearInterval(timer);
			}, []);

			const live = state.current.rate;
			return { rate: live !== undefined && live > 0 ? live : model.average, live };
		}
		//#endregion

		//#region lib/types/client/gauge.js
		/** The dial sweep: 270°, from lower-left to lower-right. */
		const A0 = -135;
		const A1 = 135;

		/**
		 * A point on the circle.
		 * @param cx - centre x.
		 * @param cy - centre y.
		 * @param r - radius.
		 * @param deg - angle (0 = top, clockwise).
		 * @returns the point.
		 */
		function polar(cx, cy, r, deg) {
			const rad = ((deg - 90) * Math.PI) / 180;
			return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
		}

		/**
		 * Describe an arc as an SVG path.
		 * @param cx - centre x.
		 * @param cy - centre y.
		 * @param r - radius.
		 * @param from - start angle in degrees.
		 * @param to - end angle in degrees.
		 * @returns the path `d` attribute.
		 */
		function arcPath(cx, cy, r, from, to) {
			const start = polar(cx, cy, r, from);
			const end = polar(cx, cy, r, to);
			const large = Math.abs(to - from) > 180 ? 1 : 0;
			return "M " + start.x.toFixed(2) + " " + start.y.toFixed(2) + " A " + r + " " + r + " 0 " + large + " 1 " + end.x.toFixed(2) + " " + end.y.toFixed(2);
		}

		/**
		 * The trip-color band for a fraction.
		 * @param fraction - 0..1.
		 * @param hard - true for a budget/limit dial (tighter bands).
		 * @returns a CSS color.
		 */
		function bandColor(fraction, hard) {
			const t1 = hard ? 0.6 : 0.55;
			const t2 = hard ? 0.85 : 0.8;
			if (fraction >= t2) return "#ef5b5b";
			if (fraction >= t1) return "#f0c322";
			return "#3ddc84";
		}

		/**
		 * One instrument dial, built the way a car's cluster is: a fixed real-world
		 * scale with colored warning zones, a needle at the current value, the
		 * figure in large type INSIDE the dial, and the fine detail printed below
		 * it. The scale is the point — 300M tokens, 500 tok/s, and $12 are the
		 * limits past which the reading itself means something is wrong.
		 *
		 * Pure SVG, so one viewBox serves both dial sizes.
		 * The needle sweeps from the inner circle outward, so the dial's centre
		 * belongs to the figure alone — no hub sits under the digits.
		 * @param props - `value`, `max`, `label` (printed under the dial, like a car
		 * gauge's caption), optional `detail`, `zones` (fractions where the warning
		 * and danger bands start), `unit`, `decimals`, and `size` (`sm` or `lg`).
		 */
		function Gauge(props) {
			const size = props.size === "lg" ? 180 : 136;
			const cx = size / 2;
			const cy = size / 2;
			const r = size / 2 - 16;
			const max = props.max > 0 ? props.max : 1;
			const value = Number.isFinite(props.value) ? Math.max(0, props.value) : 0;
			const fraction = Math.max(0, Math.min(1, value / max));
			const angle = A0 + (A1 - A0) * fraction;
			const span = A1 - A0;
			const zones = props.zones || [0.6, 0.85];
			const accent = fraction >= zones[1] ? "#ef5b5b" : fraction >= zones[0] ? "#f0c322" : "#3ddc84";

			// Warning and danger bands, exactly where the reading stops being normal.
			const bands = [
				{ from: A0, to: A0 + span * zones[0], color: "#3ddc84" },
				{ from: A0 + span * zones[0], to: A0 + span * zones[1], color: "#f0c322" },
				{ from: A0 + span * zones[1], to: A1, color: "#ef5b5b" }
			];

			// Marching ticks: every 5% minor, every 25% major.
			const ticks = [];
			for (let i = 0; i <= 40; i += 1) {
				const deg = A0 + (span * i) / 40;
				const major = i % 10 === 0;
				const outer = polar(cx, cy, r + 8, deg);
				const inner = polar(cx, cy, r + (major ? 0 : 3), deg);
				ticks.push(
					react.createElement("line", {
						key: "t" + i,
						x1: outer.x,
						y1: outer.y,
						x2: inner.x,
						y2: inner.y,
						stroke: major ? "rgba(233,241,236,0.45)" : "rgba(233,241,236,0.14)",
						strokeWidth: major ? 1.3 : 0.8,
						strokeLinecap: "round"
					})
				);
			}

			// From the inner circle outward: the centre stays clear for the readout,
			// which is what gives a big figure its impact.
			const needleInner = polar(cx, cy, r - 20, angle);
			const needleOuter = polar(cx, cy, r - 5, angle);
			const readout = splitAbbr(value);
			const start = polar(cx, cy, r, A0);
			const end = polar(cx, cy, r, A1);

			return react.createElement(
				"div",
				{ className: "td-gauge" },
				react.createElement(
					"div",
					{ className: "td-gauge-plot" },
					react.createElement(
						"svg",
						{ viewBox: "0 0 " + size + " " + size, className: "td-gauge-svg", role: "img", "aria-label": props.label },
						react.createElement("circle", { cx, cy, r, fill: "none", stroke: "rgba(255,255,255,0.05)", strokeWidth: 10 }),
						bands.map((band, index) =>
							react.createElement("path", {
								key: "b" + index,
								d: arcPath(cx, cy, r, band.from, band.to),
								fill: "none",
								stroke: band.color,
								strokeWidth: 10,
								opacity: 0.85
							})
						),
						// the bright arc shows how far the needle has travelled
						react.createElement("path", {
							d: arcPath(cx, cy, r, A0, Math.max(A0 + 0.5, angle)),
							fill: "none",
							stroke: accent,
							strokeWidth: 10,
							strokeLinecap: "round"
						}),
						ticks,
						// scale end labels, like the numbers printed on a real dial face
						react.createElement(
							"text",
							{
								x: start.x,
								y: start.y + 13,
								fill: "rgba(233,241,236,0.4)",
								fontSize: 9,
								textAnchor: "middle"
							},
							"0"
						),
						react.createElement(
							"text",
							{
								x: end.x,
								y: end.y + 13,
								fill: "rgba(233,241,236,0.4)",
								fontSize: 9,
								textAnchor: "middle"
							},
							abbr(max)
						),
						react.createElement("circle", {
							cx,
							cy,
							r: r - 20,
							fill: "none",
							stroke: "rgba(255,255,255,0.06)",
							strokeWidth: 1
						}),
						react.createElement("line", {
							x1: needleInner.x,
							y1: needleInner.y,
							x2: needleOuter.x,
							y2: needleOuter.y,
							stroke: "#ff5d5d",
							strokeWidth: 3,
							strokeLinecap: "round"
						})
					),
					react.createElement(
						"div",
						{ className: "td-gauge-readout" },
						react.createElement(
							"div",
							{ className: "td-gauge-value" + (props.size === "lg" ? " td-gauge-value-lg" : "") },
							readout.value,
							readout.unit ? react.createElement("span", { className: "td-gauge-unit" }, readout.unit) : null
						),
						props.unit ? react.createElement("div", { className: "td-gauge-unit-label" }, props.unit) : null
					)
				),
				// caption + fine detail live BELOW the dial, like a car gauge's label
				react.createElement("div", { className: "td-gauge-label" }, props.label),
				props.detail
					? react.createElement(
							"div",
							{ className: "td-gauge-detail" },
							String(props.detail)
								.split("\n")
								.map((line, index) =>
									react.createElement("div", { key: "d" + index }, line)
								)
						)
					: null
			);
		}

		//#endregion

		//#region lib/types/client/icons.js
		/** Grip glyph — the panel ships no icon-font dependency. */
		function GripIcon() {
			return react.createElement(
				"svg",
				{ width: 10, height: 14, viewBox: "0 0 10 14", "aria-hidden": "true", focusable: "false" },
				[3, 7, 11].map((y) =>
					[3, 7].map((x) =>
						react.createElement("circle", { key: x + "-" + y, cx: x, cy: y, r: 1.15, fill: "currentColor" })
					)
				)
			);
		}

		/**
		 * Render a chevron in the requested direction.
		 * @param props - `dir` is `up` (collapse) or `down` (expand).
		 */
		function ChevronIcon(props) {
			return react.createElement(
				"svg",
				{
					width: 13,
					height: 13,
					viewBox: "0 0 16 16",
					"aria-hidden": "true",
					focusable: "false",
					style: { transform: props.dir === "down" ? "rotate(180deg)" : "none" }
				},
				react.createElement("path", {
					d: "M4 10l4-4 4 4",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.6,
					strokeLinecap: "round",
					strokeLinejoin: "round"
				})
			);
		}
		//#endregion

		//#region lib/types/client/panel.js
		/**
		 * The floating meter.
		 *
		 * Geometry lives in component state and is persisted, so a reload restores
		 * the exact spot and size. Dragging and resizing are plain pointer events
		 * tracked on the window, so a gesture survives the pointer leaving the
		 * panel and no library is required.
		 * @param props - `ctx` (the plugin context) and the slot's `useSessions` seat.
		 */
		function TokenDashboard(props) {
			const sessions = props.ctx.sessions;

			// A root-scope slot receives the global standard kit, not the session
			// one, so the current session id comes from the list feed.
			const sessionId = props.useSessions((state) => state && state.current);
			const model = useTokenModel(sessions, sessionId);
			const throughput = useThroughput(model);

			const [size, setSize] = react.useState(loadSize);
			const [pos, setPos] = react.useState(() => loadPos(loadSize()));
			const [collapsed, setCollapsed] = react.useState(loadCollapsed);
			const [gesture, setGesture] = react.useState(null);
			const drag = react.useRef(null);
			const posRef = react.useRef(pos);
			const sizeRef = react.useRef(size);

			// Keep the panel reachable when the window shrinks under a saved spot.
			react.useEffect(() => {
				const onResize = () => {
					const maxW = Math.max(MIN_W, window.innerWidth - MARGIN * 2);
					setSize((prev) => (prev.w > maxW ? { w: maxW, h: prev.h } : prev));
					setPos((prev) => clamp(prev, sizeRef.current));
				};
				window.addEventListener("resize", onResize);
				return () => window.removeEventListener("resize", onResize);
			}, []);

			// One gesture handler serves both drag (header) and resize (corner).
			react.useEffect(() => {
				const onMove = (event) => {
					const active = drag.current;
					if (!active) return;
					if (active.kind === "drag") {
						setPos({ x: event.clientX - active.dx, y: event.clientY - active.dy });
						return;
					}
					const maxW = Math.max(MIN_W, window.innerWidth - MARGIN * 2);
					setSize({
						w: Math.min(maxW, Math.max(MIN_W, active.w + (event.clientX - active.startX))),
						h: Math.max(MIN_H, active.h + (event.clientY - active.startY))
					});
				};
				const onUp = () => {
					if (!drag.current) return;
					drag.current = null;
					setGesture(null);
					const settled = clamp(posRef.current, sizeRef.current);
					posRef.current = settled;
					savePos(settled);
					saveSize(sizeRef.current);
					setPos(settled);
				};
				window.addEventListener("pointermove", onMove);
				window.addEventListener("pointerup", onUp);
				window.addEventListener("pointercancel", onUp);
				return () => {
					window.removeEventListener("pointermove", onMove);
					window.removeEventListener("pointerup", onUp);
					window.removeEventListener("pointercancel", onUp);
				};
			}, []);

			const onHeaderPointerDown = react.useCallback((event) => {
				if (event.button !== 0) return;
				if (event.target && event.target.closest && event.target.closest("button, a")) return;
				event.preventDefault();
				drag.current = { kind: "drag", dx: event.clientX - posRef.current.x, dy: event.clientY - posRef.current.y };
				setGesture("drag");
			}, []);

			const onResizePointerDown = react.useCallback((event) => {
				if (event.button !== 0) return;
				event.preventDefault();
				event.stopPropagation();
				drag.current = {
					kind: "resize",
					startX: event.clientX,
					startY: event.clientY,
					w: sizeRef.current.w,
					h: sizeRef.current.h
				};
				setGesture("resize");
			}, []);

			const toggleCollapsed = react.useCallback(() => {
				setCollapsed((prev) => {
					saveCollapsed(!prev);
					return !prev;
				});
			}, []);

			posRef.current = pos;
			sizeRef.current = size;

			const stats = model.stats;
			const contextRatio = model.windowSize && model.projected !== undefined ? model.projected / model.windowSize : undefined;
			const rate = throughput.rate;
			const rateFraction =
				rate !== undefined && model.average ? Math.min(1, rate / Math.max(model.average * 1.5, 1)) : rate ? 1 : 0;
			const accent = bandColor(rateFraction, false);

			const header = react.createElement(
				"div",
				{
					className: "td-header",
					onPointerDown: onHeaderPointerDown,
					title: "drag to move",
					style: { cursor: gesture === "drag" ? "grabbing" : "grab" }
				},
				react.createElement("span", { className: "td-grip" }, react.createElement(GripIcon, null)),
				react.createElement("span", { className: "td-title" }, "TOKEN METER"),
				react.createElement("span", {
					className: "td-dot-live" + (model.hasData ? "" : " td-dot-idle"),
					title: model.hasData ? "projections flowing" : "no projections"
				}),
				react.createElement(
					"span",
					{ className: "td-status" },
					(model.via === "binding" ? "binding" : model.via === "scope" ? "scope" : model.via) +
						" · " +
						(sessionId ? String(sessionId).replace(/^session-/, "").slice(0, 8) + " · " : "") +
						(model.hasData ? "out " + exact(model.outputTokens) : "no data")
				),
				react.createElement(
					"button",
					{
						type: "button",
						className: "td-btn",
						onClick: toggleCollapsed,
						title: collapsed ? "expand" : "collapse",
						"aria-label": collapsed ? "expand" : "collapse"
					},
					react.createElement(ChevronIcon, { dir: collapsed ? "down" : "up" })
				)
			);

			const gauges = react.createElement(
				"div",
				{ className: "td-gauges" },
				react.createElement(Gauge, {
					label: "Token Usage",
					value: model.totalTokens,
					max: SCALE_TOKENS,
					zones: ZONES.tokens,
					unit: "tokens",
					detail: "In " + abbr(model.inputTokens) + "\nOut " + abbr(model.outputTokens)
				}),
				react.createElement(Gauge, {
					size: "lg",
					label: "tok/s",
					value: rate === undefined ? 0 : rate,
					max: SCALE_RATE,
					zones: ZONES.rate,
					unit: throughput.live !== undefined && throughput.live > 0 ? "live" : "session avg",
					detail: "avg " + (model.average === undefined ? "—" : model.average.toFixed(1))
				}),
				react.createElement(Gauge, {
					label: "Total Cost",
					value: model.cost,
					max: SCALE_COST,
					zones: ZONES.cost,
					unit: "est.",
					detail: "Budget " + money(model.budget)
				})
			);

			const body = collapsed ? null : react.createElement("div", { className: "td-body" }, gauges);

			const empty =
				!collapsed && !model.hasData
					? react.createElement(
							"div",
							{ className: "td-empty" },
							sessionId
								? "waiting for projections (route: " + model.via + ")"
								: "no session selected"
						)
					: null;

			return react.createElement(
				"div",
				{
					className: "td-root" + (gesture ? " td-gesture" : ""),
					style: { left: pos.x + "px", top: pos.y + "px", width: size.w + "px" }
				},
				header,
				body,
				empty,
				react.createElement("div", {
					className: "td-resize",
					onPointerDown: onResizePointerDown,
					title: "drag to resize"
				})
			);
		}
		//#endregion

		//#region lib/types/client/styles.js
		/**
		 * Panel stylesheet.
		 *
		 * The meter deliberately keeps the dark instrument look of its reference
		 * design, so its palette is declared here instead of inherited from the
		 * host theme: the declarations below rebind the `--dsw-*` aliases for this
		 * subtree only, which keeps the panel readable in light mode without
		 * touching any other surface. Typography still rides the theme's font
		 * token so the panel matches the shell.
		 */
		const CSS = `
.td-root {
  --dsw-alias-bg-layer-2: #0d1411;
  --dsw-alias-border-l2: rgba(233, 241, 236, 0.10);
  --dsw-alias-label-primary: #e9f1ec;
  --dsw-alias-label-secondary: #9fb3a8;
  --dsw-alias-interactive-bg-hover: rgba(233, 241, 236, 0.10);
  position: fixed;
  z-index: 40;
  min-width: ${MIN_W}px;
  border-radius: 14px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  background:
    radial-gradient(120% 90% at 50% -10%, rgba(61, 220, 132, 0.07), transparent 60%),
    var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
  font-family: var(--dsw-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  line-height: 1.45;
  user-select: none;
  -webkit-user-select: none;
  overflow: hidden;
}
.td-gesture { box-shadow: 0 22px 60px rgba(0, 0, 0, 0.65); }
.td-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px 5px 9px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  touch-action: none;
}
.td-grip { display: inline-flex; opacity: 0.4; }
.td-title { font-size: 10px; letter-spacing: 0.16em; font-weight: 600; }
.td-dot-live { width: 6px; height: 6px; border-radius: 50%; background: #3ddc84; box-shadow: 0 0 8px rgba(61, 220, 132, 0.9); }
.td-dot-idle { background: #6b7d74; box-shadow: none; }
.td-status { margin-left: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--dsw-alias-label-secondary); font-size: 9.5px; font-variant-numeric: tabular-nums; }
.td-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
}
.td-btn:hover { opacity: 1; background: var(--dsw-alias-interactive-bg-hover); }
.td-body { padding: 4px 10px 8px; }
.td-gauges { display: flex; align-items: flex-start; justify-content: center; gap: 6px; min-width: 0; }
.td-gauge-plot { flex: none; }
.td-gauge {
  display: flex;
  flex-direction: column;
  align-items: center;
  container-type: inline-size;
}
.td-gauge:nth-child(1), .td-gauge:nth-child(3) { flex: 0 1 132px; }
.td-gauge:nth-child(2) { flex: 0 1 176px; }
.td-gauge-plot { position: relative; width: 100%; }
.td-gauge-svg { width: 100%; height: auto; display: block; }
.td-gauge-readout {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  pointer-events: none;
}
.td-gauge-unit-label {
  margin-top: 0;
  font-size: 7.8cqw;
  letter-spacing: 0.04em;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.td-gauge-label {
  max-width: 100%;
  margin-top: 4px;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  letter-spacing: 0.05em;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 2px;
}
.td-gauge-value {
  /* Sized in container units so a value like "186.5M" can never outgrow its ring:
     the dial, not the stylesheet, decides how much room the digits get. */
  font-size: 19cqw;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.td-gauge-value-lg { font-size: 15cqw; }
.td-gauge-unit { font-size: 0.52em; font-weight: 600; margin-left: 1px; opacity: 0.8; }
.td-gauge-detail {
  margin-top: 1px;
  max-width: 100%;
  font-size: 8.5px;
  line-height: 1.35;
  color: var(--dsw-alias-label-secondary);
  /* Wraps rather than clipping: a small dial cannot fit "In 72.2M · Out 35.0K"
     on one line, and an ellipsis would hide the number the row exists to show. */
  white-space: normal;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
.td-empty { padding: 0 14px 10px; color: var(--dsw-alias-label-secondary); font-size: 9.5px; }
.td-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
  touch-action: none;
  background: linear-gradient(135deg, transparent 48%, rgba(233, 241, 236, 0.3) 48%);
  border-bottom-right-radius: 14px;
}
`;
		//#endregion

		//#region lib/types/client/index.js
		/**
		 * Register the meter on the frame-wide overlay seat.
		 *
		 * `shell.overlay` is a click-through `list` seat, so contributing is
		 * additive — a fresh `id` sits beside the shipped entries — and the panel
		 * never blocks the application underneath.
		 * @param ctx - client Cordis context.
		 */
		function apply(ctx) {
			ctx.effect(() => {
				const style = document.createElement("style");
				style.setAttribute("data-plugin", "@stone100010/dsh-token-gauge");
				style.textContent = CSS;
				document.head.appendChild(style);

				const dispose = ctx.slots.register(
					{
						name: SLOT,
						id: SLOT_ID,
						order: 50,
						label: "Token meter",
						registrant: name
					},
					(slotProps) => react.createElement(TokenDashboard, { ctx, useSessions: slotProps.useSessions })
				);

				return () => {
					dispose();
					style.remove();
				};
			});
		}
		//#endregion

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
