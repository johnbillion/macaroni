import { useEffect, useRef } from "preact/hooks";

// Every keyboard shortcut in the app, in one table. Handlers stay with the component that owns the
// state or DOM node they act on — this is only the key map, so the combos can be read (and checked
// for collisions) in one place. Shortcuts are ⌘ + key unless marked `bare`; ⌘⌥ and ⌘⌃ variants are
// deliberately left alone so system and WebView bindings still work.
//
// A `bare` shortcut has no modifier, so it can't fire while the user is typing — those are ignored
// whenever a text field has focus (see `isTyping`).
export const SHORTCUTS = {
	focusSearch: { keys: ["f", "k"], label: "Focus search" },
	selectNextReport: { keys: ["j", "arrowdown"], bare: true, label: "Select next report" },
	selectPrevReport: { keys: ["k", "arrowup"], bare: true, label: "Select previous report" },
	openReport: { keys: ["o"], label: "Open selected report on HackerOne" },
	saveReport: { keys: ["s"], label: "Save selected report as file" },
	openSettings: { keys: [","], label: "Open settings" },
	showShortcuts: { keys: ["?"], bare: true, label: "Show keyboard shortcuts" },
} as const satisfies Record<string, { keys: readonly string[]; bare?: true; label: string }>;

export type ShortcutName = keyof typeof SHORTCUTS;
type Shortcut = (typeof SHORTCUTS)[ShortcutName];

// Keys whose `KeyboardEvent.key` name isn't what you'd want printed on a keycap.
const KEY_LABELS: Record<string, string> = {
	arrowdown: "↓",
	arrowup: "↑",
};

/** How a single key of a shortcut reads on screen. The ⌘-or-nothing rule above lives here too. */
export function comboLabel(shortcut: Shortcut, key: string): string {
	const label = KEY_LABELS[key] ?? key.toUpperCase();
	return "bare" in shortcut ? label : `⌘ ${label}`;
}

// Bare keys belong to whatever the user is typing into, not to the app.
function isTyping(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

// Nor should a bare key drive the page behind an open modal.
function isModalOpen(): boolean {
	return document.querySelector("dialog[open]") !== null;
}

// Which shortcut currently owns each combo, so two components claiming the same one is a warning at
// mount rather than a silent double-fire. Keyed by the printed combo, so ⌘K and a bare K are
// distinct owners rather than a false collision.
const owners = new Map<string, ShortcutName>();

function claim(name: ShortcutName, shortcut: Shortcut) {
	const combos = shortcut.keys.map((key) => comboLabel(shortcut, key));
	for (const combo of combos) {
		const owner = owners.get(combo);
		if (owner && owner !== name) {
			console.warn(`Shortcut collision: ${combo} is claimed by both "${owner}" and "${name}"`);
			continue;
		}
		owners.set(combo, name);
	}
	return () => {
		for (const combo of combos) {
			if (owners.get(combo) === name) owners.delete(combo);
		}
	};
}

/**
 * Run `handler` when the user presses the combo registered under `name`. Pass `enabled: false` to
 * make the shortcut inert without unmounting the component that owns it.
 */
export function useShortcut(name: ShortcutName, handler: () => void, enabled = true) {
	const latest = useRef(handler);
	useEffect(() => {
		latest.current = handler;
	});
	useEffect(() => {
		if (!enabled) return;
		const shortcut: Shortcut = SHORTCUTS[name];
		const bare = "bare" in shortcut;
		const keys: readonly string[] = shortcut.keys;
		const release = claim(name, shortcut);
		const onKeyDown = (e: KeyboardEvent) => {
			// A handler closer to the target that already consumed the key wins over the global map.
			if (e.defaultPrevented) return;
			if (e.altKey || e.ctrlKey) return;
			if (bare ? e.metaKey : !e.metaKey) return;
			// A bare key is only a shortcut when it isn't a character the user meant to type.
			if (bare && (isTyping(e.target) || isModalOpen())) return;
			if (!keys.includes(e.key.toLowerCase())) return;
			e.preventDefault();
			latest.current();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			release();
		};
	}, [name, enabled]);
}
