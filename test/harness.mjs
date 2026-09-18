/**
 * Execution harness for this package's browser half.
 *
 * The panel is written against the DSH client plugin contract, which cannot be
 * booted outside the Web GUI. This harness therefore executes the real bundle
 * against faithful stand-ins for the four pieces the panel touches — the
 * ModuleLoader facade, React, `ctx.slots`, and `ctx.sessions` — so the actual
 * registration, projection subscription, render, drag, and persistence paths
 * all run for real.
 *
 * Run: node test/harness.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const bundlePath = join(root, 'lib', 'client.js');

// Read the package name rather than hardcoding it: the bundle id, the loader
// row, and the storage prefix all follow it, so a rename must not need a test
// edit (tools/rename.mjs rewrites these strings when it does).
const PKG_NAME = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
const PKG_SLUG = PKG_NAME.replace(/^@[^/]+\//, '');

let failures = 0;
let checks = 0;

/**
 * Assert one condition.
 * @param label - what is being asserted.
 * @param condition - the condition.
 * @param detail - extra detail printed on failure.
 */
function ok(label, condition, detail) {
	checks += 1;
	if (condition) {
		console.log('  ok   ' + label);
		return;
	}
	failures += 1;
	console.log('  FAIL ' + label + (detail === undefined ? '' : '  → ' + detail));
}

/** @returns whether two values are deeply equal (JSON comparison). */
function same(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * React's dependency comparison.
 *
 * This must be `Object.is` on each element, not JSON equality: projection faces
 * and callbacks are objects whose only members are functions, so a JSON
 * comparison collapses two distinct values to the same `"{}"` and silently
 * suppresses every dependency change.
 * @param a - previous dependency list.
 * @param b - next dependency list.
 * @returns whether the lists are dependency-equal.
 */
function depsEqual(a, b) {
	if (a === undefined || b === undefined) return a === b;
	if (a.length !== b.length) return false;
	return a.every((value, index) => Object.is(value, b[index]));
}

// ── DOM / storage stand-ins ─────────────────────────────────────────────────

/** Minimal element stand-in: the panel only creates one `<style>` node. */
function makeElement(tag) {
	return {
		tagName: tag,
		attributes: {},
		textContent: '',
		children: [],
		removed: false,
		parent: null,
		setAttribute(name, value) {
			this.attributes[name] = value;
		},
		appendChild(child) {
			this.children.push(child);
			child.parent = this;
			return child;
		},
		remove() {
			this.removed = true;
			if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
		}
	};
}

const head = makeElement('head');
const storage = new Map();

/**
 * Controllable interval registry.
 *
 * The throughput sampler runs on a 1s interval, so the harness drives time
 * explicitly instead of waiting on real timers: a test advances the fake clock
 * and every registered interval runs once, keeping assertions deterministic.
 */
const intervals = new Map();
const timeouts = new Map();
let nextIntervalId = 0;
let nextTimeoutId = 0;

/** Run every registered interval once. */
function advanceInterval() {
	for (const fn of [...intervals.values()]) fn();
}

/** Run every pending timeout once (the route-retry path uses these). */
function advanceTimeout() {
	const pending = [...timeouts.entries()];
	timeouts.clear();
	for (const [, fn] of pending) fn();
}

globalThis.document = {
	head,
	createElement: makeElement
};
globalThis.window = {
	innerWidth: 1440,
	innerHeight: 900,
	listeners: {},
	localStorage: {
		getItem: (k) => (storage.has(k) ? storage.get(k) : null),
		setItem: (k, v) => storage.set(k, String(v)),
		removeItem: (k) => storage.delete(k)
	},
	setTimeout: (fn) => {
		const id = ++nextTimeoutId;
		timeouts.set(id, fn);
		return id;
	},
	clearTimeout: (id) => {
		timeouts.delete(id);
	},
	setInterval: (fn) => {
		const id = ++nextIntervalId;
		intervals.set(id, fn);
		return id;
	},
	clearInterval: (id) => {
		intervals.delete(id);
	},
	addEventListener(type, fn) {
		(this.listeners[type] ||= []).push(fn);
	},
	removeEventListener(type, fn) {
		this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
	},
	/** Test-side gesture dispatch. */
	dispatch(type, event) {
		for (const fn of [...(this.listeners[type] || [])]) fn(event);
	}
};

// ── React stand-in with a hook dispatcher ──────────────────────────────────

let hookCursor = 0;
const hookState = [];
let component = null;
let pendingRender = false;
const subscriptionIds = new WeakMap();
let nextSubscriptionId = 0;

/**
 * Render the registered component, then run effects whose dependencies moved,
 * repeating until nothing is queued. Returns the LAST committed tree.
 *
 * The two loops matter: a plain render pass may queue state, and an effect may
 * queue more, so the first pass's tree is discarded and only a pass that ends
 * clean is returned.
 * @returns the settled element tree.
 */
function settle() {
	let element = null;
	for (let pass = 0; pass < 24; pass += 1) {
		pendingRender = false;
		hookCursor = 0;
		element = component(componentProps);
		flushEffects();
		if (!pendingRender) return element;
	}
	// Drain and hand back the last tree even if the component never quiesces.
	pendingRender = false;
	hookCursor = 0;
	return component(componentProps);
}

/** Run pending effects in declaration order (cleanups first, then effects). */
function flushEffects() {
	for (const slot of hookState) {
		if (slot.kind !== 'effect') continue;
		if (slot.deps && slot.lastDeps && depsEqual(slot.deps, slot.lastDeps)) continue;
		if (typeof slot.cleanup === 'function') slot.cleanup();
		slot.cleanup = undefined;
	}
	for (const slot of hookState) {
		if (slot.kind !== 'effect') continue;
		if (slot.deps && slot.lastDeps && depsEqual(slot.deps, slot.lastDeps)) continue;
		slot.lastDeps = slot.deps ? [...slot.deps] : undefined;
		slot.cleanup = slot.fn() || undefined;
	}
}

/** Tear down every effect (simulates unmount). */
function unmount() {
	for (const slot of hookState) {
		if (slot.kind === 'effect' && typeof slot.cleanup === 'function') slot.cleanup();
		slot.cleanup = undefined;
	}
}

const react = {
	createElement(type, props, ...children) {
		const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
		if (typeof type === 'function') return { kind: 'component', type, props: props || {}, children: flat };
		return { kind: 'element', type, props: props || {}, children: flat };
	},
	useState(initial) {
		const slot = (hookState[hookCursor] ||= {
			kind: 'state',
			value: typeof initial === 'function' ? initial() : initial
		});
		hookCursor += 1;
		const set = (next) => {
			const value = typeof next === 'function' ? next(slot.value) : next;
			if (Object.is(value, slot.value)) return;
			slot.value = value;
			pendingRender = true;
		};
		return [slot.value, set];
	},
	useMemo(factory, deps) {
		const slot = (hookState[hookCursor] ||= { kind: 'memo', deps: undefined, value: undefined });
		hookCursor += 1;
		if (slot.deps === undefined || !depsEqual(slot.deps, deps)) {
			slot.value = factory();
			slot.deps = deps ? [...deps] : undefined;
		}
		return slot.value;
	},
	useCallback(fn, deps) {
		return react.useMemo(() => fn, deps);
	},
	useRef(initial) {
		const slot = (hookState[hookCursor] ||= { kind: 'ref', value: { current: initial } });
		hookCursor += 1;
		return slot.value;
	},
	useEffect(fn, deps) {
		const slot = (hookState[hookCursor] ||= {
			kind: 'effect',
			deps: undefined,
			lastDeps: undefined,
			cleanup: undefined,
			fn: undefined
		});
		hookCursor += 1;
		slot.fn = fn;
		slot.deps = deps;
	},
	useSyncExternalStore(subscribe, getSnapshot) {
		const slot = (hookState[hookCursor] ||= {
			kind: 'store',
			id: undefined,
			value: undefined,
			unsubscribe: undefined,
			subscribe: undefined
		});
		hookCursor += 1;
		// Identity of the subscribe pair, not of this render's closure: mirrors
		// React, which re-subscribes only when the function identity changes.
		let id = subscriptionIds.get(subscribe);
		if (id === undefined) {
			id = ++nextSubscriptionId;
			subscriptionIds.set(subscribe, id);
		}
		if (slot.id !== id) {
			if (typeof slot.unsubscribe === 'function') slot.unsubscribe();
			slot.id = id;
			slot.subscribe = subscribe;
			slot.value = getSnapshot();
			slot.unsubscribe = subscribe(() => {
				const next = getSnapshot();
				if (!Object.is(next, slot.value)) {
					slot.value = next;
					pendingRender = true;
				}
			});
		}
		return slot.value;
	}
};

// ── ModuleLoader facade ─────────────────────────────────────────────────────

let registeredFactory = null;
globalThis.window.__ModuleLoader__ = {
	load({ id, factory }) {
		registeredFactory = { id, factory };
	}
};

/** Observable face over a mutable value, shaped like the projection store's. */
function makeFace(initial) {
	let value = initial;
	const listeners = new Set();
	return {
		getSnapshot: () => value,
		subscribe(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		/** Test-side push. */
		push(next) {
			value = next;
			for (const fn of [...listeners]) fn();
		}
	};
}

// ── The four required modules ──────────────────────────────────────────────

/**
 * Per-session projection stores.
 *
 * Session scope is an identity axis: each session owns its own projection
 * store, so one session's values must never leak into another's panel. The
 * harness mirrors that, or the switch case would prove nothing.
 */
const stores = new Map();

/**
 * Build one session's projection faces. A fresh session starts with every key
 * absent, exactly as a host that has not yet reported usage does.
 * @returns the session's face registry.
 */
function makeFaces() {
	return {
		tokenUsage: makeFace(undefined),
		contextPressure: makeFace(undefined),
		contextBreakdown: makeFace(undefined),
		sessionStats: makeFace(undefined)
	};
}

/**
 * Read (or lazily create) one session's projection store. Session scope is an
 * identity axis: each session owns its own store, so one session's values must
 * never leak into another's panel. The harness mirrors that, or the switch case
 * would prove nothing.
 * @param sessionId - session id.
 * @returns the session's store.
 */
function storeFor(sessionId) {
	if (!stores.has(sessionId)) {
		const sessionFaces = makeFaces();
		stores.set(sessionId, {
			faces: sessionFaces,
			projections: {
				faceOf(key) {
					if (sessionId === currentSessionId) faceOfCalls.push(key);
					return sessionFaces[key];
				}
			}
		});
	}
	return stores.get(sessionId);
}

let currentSessionId = 'session-78f8f077-d468-47ce-be81-57521e24801a';
let scopeThrows = false;
let bindingThrows = false;
let sessionOfScopes = 0;
let bindingCalls = 0;
const faceOfCalls = [];

/** The default session's faces, used by the push side of the tests. */
const faces = storeFor(currentSessionId).faces;

/**
 * The sessions service, offering both public routes the panel tries: the plain
 * `binding()` accessor (primary) and the `scope()` + `sessionOf()` pair
 * (fallback). Each is independently breakable so the fallback is provable.
 */
const sessionsService = {
	list: null,
	binding(id) {
		bindingCalls += 1;
		if (bindingThrows) throw new Error('binding unavailable');
		const store = id === undefined ? undefined : stores.get(id);
		return store ? { sessionId: id, session: store } : undefined;
	},
	scope(id) {
		if (scopeThrows) throw new Error('scope unavailable');
		return id === undefined ? undefined : { __scoped: id };
	},
	sessionOf(scoped) {
		sessionOfScopes += 1;
		return scoped ? stores.get(scoped.__scoped) : undefined;
	}
};

/** Captured registration from `ctx.slots.register`, and the fiber effect's disposer. */
let registration = null;
let effectDisposer = null;

const ctx = {
	sessions: sessionsService,
	effect(fn) {
		effectDisposer = fn();
		return { dispose: () => effectDisposer && effectDisposer() };
	},
	slots: {
		register(options, registered) {
			registration = { options, component: registered };
			component = registered;
			return () => {
				registration = null;
				component = null;
			};
		}
	}
};

const modules = {
	'@deepseek-ai/cordis': { name: 'cordis-stub' },
	'@deepseek-ai/dsh-api-session-controller/client': { __esModule: true },
	'@deepseek-ai/dsh-client-ui-slots': { SlotCore: class SlotCore {} },
	react
};

// ── Tree walking ───────────────────────────────────────────────────────────

const seen = [];

/**
 * Walk a rendered tree, descending through function components.
 * @param node - element, component, array, or text node.
 */
function walk(node) {
	if (node === null || node === undefined || node === false || node === true) return;
	if (Array.isArray(node)) {
		for (const child of node) walk(child);
		return;
	}
	if (typeof node === 'string' || typeof node === 'number') {
		seen.push({ type: '#text', text: String(node) });
		return;
	}
	if (typeof node !== 'object') return;
	if (node.kind === 'component') {
		walk(node.type(node.props));
		return;
	}
	seen.push({
		type: node.type,
		className: node.props && node.props.className,
		text: node.children.filter((c) => typeof c === 'string').join(''),
		// Numbers are real JSX children (a computed figure inside a <b>), so keep
		// them reachable for assertions instead of dropping them.
		children: node.children.filter((c) => typeof c === 'string' || typeof c === 'number'),
		props: node.props || {}
	});
	for (const child of node.children) walk(child);
}

/**
 * Settle, then walk the committed tree.
 * @returns the flattened nodes and their joined text.
 */
function snapshot() {
	const tree = settle();
	seen.length = 0;
	walk(tree);
	return {
		tree,
		nodes: [...seen],
		text: seen.map((n) => n.text).filter(Boolean).join(' | ')
	};
}

// ── Run the bundle ─────────────────────────────────────────────────────────

console.log(PKG_NAME + ' harness\n');

const source = readFileSync(bundlePath, 'utf8');
// eslint-disable-next-line no-new-func
new Function('window', 'document', source)(globalThis.window, globalThis.document);

ok('bundle registers exactly one ModuleLoader entry', registeredFactory !== null);
ok(
	'bundle id is the package id',
	registeredFactory && registeredFactory.id === PKG_NAME,
	String(registeredFactory && registeredFactory.id)
);

const exports_ = registeredFactory.factory((name) => {
	if (!(name in modules)) throw new Error('unexpected require: ' + name);
	return modules[name];
});
ok('bundle resolves with only baseline externals', true);

ok('browser half exports apply()', typeof exports_.apply === 'function');
ok('browser half exports a plugin name', exports_.name === 'token-dashboard', String(exports_.name));
ok('browser half injects slots and sessions', same(exports_.inject, ['slots', 'sessions']), JSON.stringify(exports_.inject));

// ── apply(): registration ──────────────────────────────────────────────────

exports_.apply(ctx);

ok('a <style> element was appended to head', head.children.length === 1, String(head.children.length));
ok(
	'the style element carries a plugin marker',
	head.children[0] && head.children[0].attributes['data-plugin'] === PKG_NAME
);
const css = head.children[0].textContent;
ok('stylesheet declares its own --dsw-* alias layer', /--dsw-alias-bg-layer-2/.test(css) && /--dsw-font-family/.test(css));
ok('stylesheet has no invented token prefix', !/--dsh-/.test(css));
ok('registration happened exactly once', registration !== null);
ok('registered into shell.overlay', registration && registration.options.name === 'shell.overlay', registration && registration.options.name);
ok('registered as a list entry with a stable id', registration && registration.options.id === PKG_SLUG);
ok('registration carries a list order', registration && registration.options.order === 50);

// ── props the slot framework would pass ────────────────────────────────────

// `useSessions` reads the live selection at call time, exactly like the slot
// framework's bound selector hook does — a snapshot-time closure would leak a
// stale session id into later renders.
const useSessions = (selector) => selector({ current: currentSessionId });
const componentProps = { ctx, useSessions, sessionId: undefined, useProjection: undefined };

/** Let queued timers (the LIVE pulse) run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));


// ── first render: dials exist, no data yet ─────────────────────────────────

let view = snapshot();

const posOf = (rendered) => {
	const node = rendered.nodes.find((n) => n.className && String(n.className).includes('td-root'));
	return { x: Number(node.props.style.left.replace('px', '')), y: Number(node.props.style.top.replace('px', '')) };
};

ok('renders a positioned root node', view.nodes.some((n) => n.className && String(n.className).includes('td-root')));
ok('header renders the meter title', view.text.includes('TOKEN METER'), view.text);
ok(
	'all three dials are labelled',
	view.text.includes('Token Usage') && view.text.includes('tok/s') && view.text.includes('Total Cost'),
	view.text
);
ok('cost dial states the budget', view.text.includes('Budget $12.00'), view.text);
ok(
	'projection faces were requested by key',
	same([...new Set(faceOfCalls)].sort(), ['contextBreakdown', 'contextPressure', 'sessionStats', 'tokenUsage']),
	JSON.stringify(faceOfCalls)
);
ok('the binding route is used first', bindingCalls > 0 && view.text.includes('binding'), view.text);
ok('the header identifies the session being read', view.text.includes('78f8f077'), view.text);

// ── live data push ─────────────────────────────────────────────────────────

// FLAT — the shape the host actually publishes (`view: state => state.totals`).
faces.tokenUsage.push({ uncachedInputTokens: 7750, outputTokens: 887, cacheReadTokens: 19200, cacheWriteTokens: 0 });
faces.contextPressure.push({ pressureTokens: 9640, contextWindow: 1000000 });
faces.contextBreakdown.push({ systemTokens: 1725, toolsTokens: 6833, messageTokens: 2902 });
ok('flat wire shapes are the fixture', !faces.tokenUsage.getSnapshot().totals);
faces.sessionStats.push({ turns: 2, steps: 12, llmMs: 60000, toolMs: 5000, ttftMs: 4000, decodeMs: 40000, decodeTokens: 8000 });

ok('a projection push schedules a re-render', pendingRender);

view = snapshot();

// In  = 7750 + 19200 + 0 = 26,950; Out = 887; total = 27,837

ok('usage dial totals both sides', view.text.includes('27.8'), view.text);
ok('usage dial splits input and output', view.text.includes('27.0K') && view.text.includes('887'), view.text);
ok('usage dial carries the input split', view.text.includes('27.0K') && view.text.includes('887'), view.text);
ok(
	'cost dial estimates the spend at the reference price',
	view.text.includes('0.0014'),
	view.text
);

// tok/s = 8000 / 40s = 200
ok('throughput dial shows the session decode rate', view.text.includes('200'), view.text);
ok('throughput dial labels the source as session avg', view.text.includes('session avg'), view.text);
ok(
	'the gauge sub-rows are gone',
	!view.text.includes('cache read') && !view.text.includes('of budget') && !view.text.includes('context'),
	view.text
);
ok('only the three dials carry figures', view.nodes.filter((n) => n.className === 'td-gauge').length === 3);

// cost = (7750*0.14 + 19200*0.0028 + 887*0.28) / 1e6 = (1085 + 53.76 + 248.36)/1e6 = 0.00138712
ok('cost dial states the budget', view.text.includes('Budget $12.00'), view.text);
ok('cost dial states the budget', view.text.includes('Budget $12.00'), view.text);
// ── the host-state (nested) shape must still resolve ──────────────────────

faces.tokenUsage.push({
	totals: { uncachedInputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 0 }
});
view = snapshot();
ok('a nested totals shape still yields figures', view.text.includes('400') && view.text.includes('200'), view.text);
faces.tokenUsage.push({ uncachedInputTokens: 8000, outputTokens: 1887, cacheReadTokens: 19200, cacheWriteTokens: 0 });
view = snapshot();

// ── a wrong-session face must not leak across the switch ───────────────────

bindingCalls = 0;
faceOfCalls.length = 0;
currentSessionId = 'session-ffffffff-0000-0000-0000-000000000000';
storeFor(currentSessionId);
pendingRender = true; // the session list feed would notify React here
view = snapshot();
ok('a new session re-resolves through its own binding', bindingCalls > 0, String(bindingCalls));
ok(
	'a session with no projections renders the waiting note',
	view.text.includes('waiting for projections'),
	view.text
);

// ── fallbacks: binding broken, then both routes broken ─────────────────────

currentSessionId = 'session-78f8f077-d468-47ce-be81-57521e24801a';
bindingThrows = true;
sessionOfScopes = 0;
pendingRender = true;
view = snapshot();
ok('the scope route takes over when binding throws', sessionOfScopes > 0 && view.text.includes('scope'), view.text);
ok('the figures survive the fallback route', view.text.includes('out 1,887') && view.text.includes('78f8f077'), view.text);

bindingThrows = true;
scopeThrows = true;
pendingRender = true;
let threw = false;
try {
	view = snapshot();
} catch (error) {
	threw = true;
	console.log('    ' + error.message);
}
ok('an exploding scope route does not break the panel', !threw);
ok('the panel reports the unresolved route', view.text.includes('unresolved'), view.text);
ok(
	'a broken route shows no figures at all rather than frozen ones',
	view.text.includes('out 0') || !/\b\d\.\d\dK\b/.test(view.text),
	view.text
);
scopeThrows = false;

// ── dragging ───────────────────────────────────────────────────────────────

view = snapshot();
const startPos = posOf(view);
const headerNode = view.nodes.find((n) => n.className === 'td-header');
ok('header node found for the drag gesture', headerNode !== undefined);
ok(
	'drag and resize listeners are bound once at mount',
	(globalThis.window.listeners.pointermove || []).length === 1 && (globalThis.window.listeners.pointerup || []).length === 1,
	JSON.stringify({ move: (globalThis.window.listeners.pointermove || []).length })
);

headerNode.props.onPointerDown({
	button: 0,
	clientX: 1000,
	clientY: 500,
	target: { closest: () => null },
	preventDefault() {}
});
ok('pointerdown queues a dragging state change', pendingRender);
settle();

globalThis.window.dispatch('pointermove', { clientX: 1040, clientY: 460 });
view = snapshot();
const movedPos = posOf(view);
ok(
	'panel followed the pointer by the same delta',
	movedPos.x === startPos.x + 40 && movedPos.y === startPos.y - 40,
	JSON.stringify({ startPos, movedPos })
);

globalThis.window.dispatch('pointerup', {});
settle();
ok(
	'position was persisted on release',
	same(JSON.parse(storage.get(PKG_SLUG + '.panel.v2')), posOf(snapshot())),
	storage.get(PKG_SLUG + '.panel.v2')
);

// ── resizing ───────────────────────────────────────────────────────────────

view = snapshot();
const widthOf = (rendered) => Number(rendered.nodes.find((n) => n.className && String(n.className).includes('td-root')).props.style.width.replace('px', ''));
const startWidth = widthOf(view);
const resizer = view.nodes.find((n) => n.className === 'td-resize');
ok('a resize handle exists', resizer !== undefined);
resizer.props.onPointerDown({ button: 0, clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() {} });
settle();
globalThis.window.dispatch('pointermove', { clientX: 180, clientY: 140 });
view = snapshot();
ok('the panel widened with the pointer', widthOf(view) === startWidth + 80, String(widthOf(view)) + ' vs ' + String(startWidth + 80));
globalThis.window.dispatch('pointerup', {});
settle();
ok('the size was persisted', JSON.parse(storage.get(PKG_SLUG + '.size.v1')).w === startWidth + 80, storage.get(PKG_SLUG + '.size.v1'));

// A drag gesture must not resize, and a resize must not move.
view = snapshot();
const beforeDrag = posOf(view);
view.nodes.find((n) => n.className === 'td-header').props.onPointerDown({
	button: 0,
	clientX: 500,
	clientY: 500,
	target: { closest: () => null },
	preventDefault() {}
});
settle();
const widthAfterDragStart = widthOf(snapshot());
ok('a header drag leaves the width alone', widthAfterDragStart === startWidth + 80, String(widthAfterDragStart));
globalThis.window.dispatch('pointerup', {});
settle();

// ── header buttons do not start a gesture ──────────────────────────────────

view = snapshot();
view.nodes
	.find((n) => n.className === 'td-header')
	.props.onPointerDown({
		button: 0,
		clientX: 5,
		clientY: 5,
		target: { closest: (sel) => (sel.includes('button') ? {} : null) },
		preventDefault() {}
	});
settle();
ok('pressing a header button does not begin a gesture', widthOf(snapshot()) === startWidth + 80);

// ── collapse toggles and persists ──────────────────────────────────────────

view = snapshot();
const collapseButton = view.nodes.find((n) => n.type === 'button');
ok('collapse button exists', collapseButton !== undefined);
collapseButton.props.onClick();
view = snapshot();
ok('collapsed panel drops the body', !view.nodes.some((n) => n.className === 'td-body'));
ok(
	'collapsed state was persisted',
	storage.get(PKG_SLUG + '.collapsed.v1') === '1' ||
		storage.get(PKG_SLUG + '.collapsed.v2') === '1',
	JSON.stringify([...storage.keys()])
);
view.nodes.find((n) => n.type === 'button').props.onClick();
view = snapshot();
ok('expanding restores the dials', view.nodes.some((n) => n.className === 'td-body'));

// ── clamping keeps the panel on screen ────────────────────────────────────

globalThis.window.innerWidth = 800;
globalThis.window.innerHeight = 600;
for (const fn of [...(globalThis.window.listeners.resize || [])]) fn();
view = snapshot();
const clampedPos = posOf(view);
ok('panel is clamped inside a shrunken window', clampedPos.x <= 800 - 436 && clampedPos.y <= 600 - 44, JSON.stringify(clampedPos));

// Route retries ride window.setTimeout, which this harness owns: drive them
// instead of sleeping on a real clock.
advanceTimeout();
pendingRender = true;
advanceTimeout();

// ── disposal ───────────────────────────────────────────────────────────────

unmount();
ok('component effects were torn down', hookState.every((slot) => slot.kind !== 'effect' || slot.cleanup === undefined));
ok('the sampler interval was cleared', intervals.size === 0, String(intervals.size));
ok('the stylesheet outlives component unmount', head.children.length === 1 && head.children[0].removed === false);

effectDisposer();
ok('fiber disposal removes the style element', head.children.length === 0, String(head.children.length));
ok('slots disposal drops the registration', registration === null);

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + '  ' + (checks - failures) + '/' + checks + ' checks\n');
process.exit(failures === 0 ? 0 : 1);
