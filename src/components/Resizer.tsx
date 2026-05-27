import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { useAppState, useDispatch } from "../state/context";
import { PANEL_BOUNDS, type PanelKey } from "../state/store";

type Orientation = "vertical" | "horizontal";

type ResizerProps = {
	panel: PanelKey;
	label: string;
	orientation?: Orientation;
	step?: number;
	/**
	 * Set when the handle sits on the *leading* edge of the panel it resizes
	 * (e.g. above a bottom-docked panel, or to the left of a right-docked
	 * panel). Drag-towards-the-panel grows it.
	 */
	invert?: boolean;
};

const DEFAULT_STEP = 16;

export function Resizer({
	panel,
	label,
	orientation = "vertical",
	step = DEFAULT_STEP,
	invert = false,
}: ResizerProps) {
	const state = useAppState();
	const dispatch = useDispatch();
	const value = state.panelSizes[panel];
	const bounds = PANEL_BOUNDS[panel];
	const isHorizontal = orientation === "horizontal";

	const [dragging, setDragging] = useState(false);
	const dragStart = useRef<{ pos: number; size: number } | null>(null);

	const setSize = useCallback(
		(size: number) => {
			dispatch({ type: "PANEL_SIZE_SET", panel, size });
		},
		[dispatch, panel],
	);

	const setSizeRef = useRef(setSize);
	setSizeRef.current = setSize;

	const onPointerDown = useCallback(
		(e: PointerEvent) => {
			if (e.button !== 0) return;
			e.preventDefault();
			dragStart.current = {
				pos: isHorizontal ? e.clientY : e.clientX,
				size: value,
			};
			setDragging(true);
		},
		[value, isHorizontal],
	);

	useEffect(() => {
		if (!dragging) return;

		const onMove = (e: PointerEvent) => {
			const start = dragStart.current;
			if (!start) return;
			const pos = isHorizontal ? e.clientY : e.clientX;
			const delta = pos - start.pos;
			setSizeRef.current(start.size + (invert ? -delta : delta));
		};
		const onUp = () => {
			dragStart.current = null;
			setDragging(false);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
		const prevSelect = document.body.style.userSelect;
		const prevCursor = document.body.style.cursor;
		document.body.style.userSelect = "none";
		document.body.style.cursor = isHorizontal ? "row-resize" : "col-resize";
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			document.body.style.userSelect = prevSelect;
			document.body.style.cursor = prevCursor;
		};
	}, [dragging, isHorizontal, invert]);

	const onKeyDown = useCallback(
		(e: KeyboardEvent) => {
			const primaryGrow = isHorizontal ? "ArrowDown" : "ArrowRight";
			const primaryShrink = isHorizontal ? "ArrowUp" : "ArrowLeft";
			const growKey = invert ? primaryShrink : primaryGrow;
			const shrinkKey = invert ? primaryGrow : primaryShrink;
			let next: number | null = null;
			if (e.key === shrinkKey) next = value - step;
			else if (e.key === growKey) next = value + step;
			else if (e.key === "Home") next = bounds.min;
			else if (e.key === "End") next = bounds.max;
			if (next == null) return;
			e.preventDefault();
			setSizeRef.current(next);
		},
		[value, step, bounds, isHorizontal, invert],
	);

	const cls = ["resizer", isHorizontal ? "resizer-h" : "resizer-v", dragging ? "resizer-dragging" : null]
		.filter(Boolean)
		.join(" ");

	return (
		<div
			class={cls}
			role="separator"
			aria-orientation={isHorizontal ? "horizontal" : "vertical"}
			aria-label={label}
			aria-valuenow={value}
			aria-valuemin={bounds.min}
			aria-valuemax={bounds.max}
			tabIndex={0}
			onPointerDown={onPointerDown}
			onKeyDown={onKeyDown}
		>
			<span class="resizer-grip" aria-hidden="true" />
		</div>
	);
}
