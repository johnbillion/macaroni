import { useEffect, useRef, useState } from "preact/hooks";
import { useAppState } from "../state/context";
import type { AsyncState, StructuredScope } from "../state/store";
import { SeverityMeter } from "./SeverityMeter";

type StateFacet = { key: string; label: string; swatch: string };

const OPEN_STATES: StateFacet[] = [
	{ key: "new", label: "New", swatch: "state-new" },
	{ key: "needs-info", label: "Needs more info", swatch: "state-needs-info" },
	{ key: "triaged", label: "Triaged", swatch: "state-triaged" },
	{ key: "retesting", label: "Retesting", swatch: "state-retesting" },
	{ key: "pending", label: "Pending program review", swatch: "state-pending" },
];

const CLOSED_STATES: StateFacet[] = [
	{ key: "duplicate", label: "Duplicate", swatch: "state-duplicate" },
	{ key: "informative", label: "Informative", swatch: "state-informative" },
	{ key: "na", label: "N/A", swatch: "state-na" },
	{ key: "resolved", label: "Resolved", swatch: "state-resolved" },
	{ key: "spam", label: "Spam", swatch: "state-spam" },
];

type SeverityFacet = { key: string; rating: string | null };

const SEVERITY_FACETS: SeverityFacet[] = [
	{ key: "critical", rating: "critical" },
	{ key: "high", rating: "high" },
	{ key: "medium", rating: "medium" },
	{ key: "low", rating: "low" },
	{ key: "none", rating: "none" },
	{ key: "unrated", rating: null },
];

function useFacetSelection(allKeys: string[], initialChecked: string[]) {
	const [checked, setChecked] = useState<Set<string>>(() => new Set(initialChecked));
	const parentRef = useRef<HTMLInputElement>(null);

	const allChecked = allKeys.length > 0 && allKeys.every((k) => checked.has(k));
	const someChecked = allKeys.some((k) => checked.has(k));

	useEffect(() => {
		if (parentRef.current) {
			parentRef.current.indeterminate = !allChecked && someChecked;
		}
	}, [allChecked, someChecked]);

	const toggleAll = () => {
		setChecked(allChecked ? new Set() : new Set(allKeys));
	};

	const toggleOne = (key: string) => {
		setChecked((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	return { checked, allChecked, parentRef, toggleAll, toggleOne };
}

// All controls in this sidebar are visual placeholders for v1.
// Filtering will be wired up in a later pass — see the plan.
export function Sidebar() {
	const state = useAppState();
	const orgPrograms = state.filters.orgId
		? state.programsByOrg[state.filters.orgId]
		: undefined;
	const program =
		orgPrograms?.status === "ready"
			? orgPrograms.data.find((p) => p.handle === state.filters.programHandle)
			: undefined;
	const scopes: AsyncState<StructuredScope[]> | undefined = program
		? state.scopesByProgram[program.id]
		: undefined;
	return (
		<aside class="side">
			<div class="side-search">
				<div class="search-box">
					<input type="search" placeholder="search" />
				</div>
			</div>

			<AssetSection key={program?.id ?? "none"} state={scopes} />

			<div class="side-section">
				<div class="side-h">
					<span>STATE</span>
				</div>

				<StateFacetGroup heading="Open" facets={OPEN_STATES} initialChecked={["new"]} />
				<StateFacetGroup heading="Closed" facets={CLOSED_STATES} initialChecked={[]} />
			</div>

			<SeveritySection />
		</aside>
	);
}

function StateFacetGroup({
	heading,
	facets,
	initialChecked,
}: {
	heading: string;
	facets: StateFacet[];
	initialChecked: string[];
}) {
	const keys = facets.map((f) => f.key);
	const { checked, allChecked, parentRef, toggleAll, toggleOne } = useFacetSelection(
		keys,
		initialChecked,
	);

	return (
		<div class="cb-group">
			<label class="check-h">
				<input
					ref={parentRef}
					type="checkbox"
					class="cb"
					checked={allChecked}
					onChange={toggleAll}
				/>
				{heading}
			</label>
			{facets.map((f) => (
				<label key={f.key} class="facet">
					<input
						type="checkbox"
						class="cb"
						checked={checked.has(f.key)}
						onChange={() => toggleOne(f.key)}
					/>
					<span class={`swatch ${f.swatch}`} /> {f.label}
				</label>
			))}
		</div>
	);
}

function SeveritySection() {
	const keys = SEVERITY_FACETS.map((f) => f.key);
	const { checked, allChecked, parentRef, toggleAll, toggleOne } = useFacetSelection(keys, keys);

	return (
		<div class="side-section">
			<div class="side-h">
				<label class="check-h">
					<input
						ref={parentRef}
						type="checkbox"
						class="cb"
						checked={allChecked}
						onChange={toggleAll}
					/>
					SEVERITY
				</label>
			</div>
			{SEVERITY_FACETS.map((f) => (
				<label key={f.key} class="facet">
					<input
						type="checkbox"
						class="cb"
						checked={checked.has(f.key)}
						onChange={() => toggleOne(f.key)}
					/>
					<SeverityMeter rating={f.rating} showLabel />
				</label>
			))}
		</div>
	);
}

function AssetSection({ state }: { state: AsyncState<StructuredScope[]> | undefined }) {
	if (!state || state.status !== "ready") {
		return (
			<div class="side-section">
				<div class="side-h">
					<label class="check-h">
						<input type="checkbox" class="cb" disabled />
						ASSET
					</label>
				</div>
				{!state || state.status === "idle" || state.status === "loading" ? (
					<div class="facet facet-muted">Loading…</div>
				) : (
					<div class="facet facet-muted">Couldn't load assets</div>
				)}
			</div>
		);
	}
	return <AssetSectionReady scopes={state.data.filter((s) => s.eligible_for_submission)} />;
}

function AssetSectionReady({ scopes }: { scopes: StructuredScope[] }) {
	const keys = scopes.map((s) => s.id);
	const { checked, allChecked, parentRef, toggleAll, toggleOne } = useFacetSelection(keys, keys);

	return (
		<div class="side-section">
			<div class="side-h">
				<label class="check-h">
					<input
						ref={parentRef}
						type="checkbox"
						class="cb"
						checked={allChecked}
						onChange={toggleAll}
						disabled={scopes.length === 0}
					/>
					ASSET
				</label>
			</div>
			{scopes.length === 0 ? (
				<div class="facet facet-muted">No assets</div>
			) : (
				scopes.map((scope) => (
					<label key={scope.id} class="facet facet-asset">
						<input
							type="checkbox"
							class="cb"
							checked={checked.has(scope.id)}
							onChange={() => toggleOne(scope.id)}
						/>
						<span>
							{scope.asset_identifier.split(",").map((part, i) => (
								<>
									{i > 0 && <br />}
									{part.trim()}
								</>
							))}
						</span>
					</label>
				))
			)}
		</div>
	);
}
