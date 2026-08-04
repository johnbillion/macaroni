import { useEffect, useRef } from "preact/hooks";
import { useAppState, useDispatch } from "../state/context";
import { buildReportsQuery, cancelPendingReportsLoad, loadReports } from "../state/effects";
import { CLOSED_STATES, OPEN_STATES, SEVERITY_FACETS, type StateFacet } from "../state/filters";
import type { AssigneeOption, AsyncState, InboxRef, TeamMember } from "../state/store";
import { AssetIdentifier } from "./AssetIdentifier";
import { SeverityMeter } from "./SeverityMeter";

export function Sidebar() {
	const state = useAppState();
	const dispatch = useDispatch();
	const handle = state.filters.programHandle;
	const assets: AsyncState<string[]> | undefined = handle
		? state.assetsByProgram[handle]
		: undefined;
	const seenAssignees = handle ? (state.assigneeOptionsByProgram[handle] ?? []) : [];
	const members = handle ? state.teamMembersByProgram[handle] : undefined;
	const memberList = members?.status === "ready" ? members.data : [];
	const assigneeOptions = buildAssigneeOptions(seenAssignees, memberList);
	const inboxes: AsyncState<InboxRef[]> | undefined = handle
		? state.inboxesByProgram[handle]
		: undefined;
	const locked = state.selectedReportIds.size > 0;
	return (
		<aside class={`side${locked ? " side-locked" : ""}`} aria-disabled={locked}>
			<form
				class="side-search"
				onSubmit={(e) => {
					e.preventDefault();
					const query = buildReportsQuery(state);
					if (!query) return;
					cancelPendingReportsLoad();
					loadReports(dispatch, query);
				}}
			>
				<div class="search-box">
					<input
						type="search"
						placeholder="search"
						value={state.filters.search}
						autoComplete="off"
						autoCorrect="off"
						autoCapitalize="off"
						spellcheck={false}
						onInput={(e) => dispatch({ type: "SEARCH_SET", search: e.currentTarget.value })}
					/>
				</div>
			</form>

			<AssetSection key={`asset-${handle ?? "none"}`} state={assets} />

			<div class="side-section">
				<div class="side-h">
					<span>State</span>
				</div>

				<StateFacetGroup heading="Open" facets={OPEN_STATES} />
				<StateFacetGroup heading="Closed" facets={CLOSED_STATES} />
			</div>

			<AssigneeSection key={`assignee-${handle ?? "none"}`} options={assigneeOptions} />

			<InboxSection key={`inbox-${handle ?? "none"}`} state={inboxes} />

			<SeveritySection />
		</aside>
	);
}

function useIndeterminate(allChecked: boolean, someChecked: boolean) {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (ref.current) ref.current.indeterminate = !allChecked && someChecked;
	}, [allChecked, someChecked]);
	return ref;
}

function StateFacetGroup({ heading, facets }: { heading: string; facets: StateFacet[] }) {
	const state = useAppState();
	const dispatch = useDispatch();
	const checked = new Set(state.filters.states);
	const groupKeys = facets.map((f) => f.key);
	const allChecked = groupKeys.every((k) => checked.has(k));
	const someChecked = groupKeys.some((k) => checked.has(k));
	const parentRef = useIndeterminate(allChecked, someChecked);

	const toggleAll = () => {
		const next = someChecked
			? state.filters.states.filter((k) => !groupKeys.includes(k))
			: [...new Set([...state.filters.states, ...groupKeys])];
		dispatch({ type: "STATES_SET", states: next });
	};
	const toggleOne = (key: string) => {
		const next = checked.has(key)
			? state.filters.states.filter((k) => k !== key)
			: [...state.filters.states, key];
		dispatch({ type: "STATES_SET", states: next });
	};

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
	const state = useAppState();
	const dispatch = useDispatch();
	const checked = new Set(state.filters.severities);
	const keys = SEVERITY_FACETS.map((f) => f.key);
	const allChecked = keys.every((k) => checked.has(k));
	const someChecked = keys.some((k) => checked.has(k));
	const parentRef = useIndeterminate(allChecked, someChecked);

	const toggleAll = () => {
		dispatch({ type: "SEVERITIES_SET", severities: someChecked ? [] : keys });
	};
	const toggleOne = (key: string) => {
		const next = checked.has(key)
			? state.filters.severities.filter((k) => k !== key)
			: [...state.filters.severities, key];
		dispatch({ type: "SEVERITIES_SET", severities: next });
	};

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
					Severity
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

function AssetSection({ state }: { state: AsyncState<string[]> | undefined }) {
	if (!state || state.status !== "ready") {
		return (
			<div class="side-section">
				<div class="side-h">
					<label class="check-h">
						<input type="checkbox" class="cb" disabled />
						Asset
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
	const visible = state.data.slice().sort((a, b) => assetSortKey(a).localeCompare(assetSortKey(b)));
	return <AssetSectionReady assets={visible} />;
}

function assetSortKey(identifier: string): string {
	return identifier.replace(/^[^\p{L}\p{N}]+/u, "").toLowerCase();
}

// System/bot accounts (HackerOne's automation users) that are never real assignees — excluded
// from the picker by username prefix.
function isSystemUser(username: string): boolean {
	return username.startsWith("auto-") || username.startsWith("h1_");
}

// Combine the full program member list (all staff, fetched for activity-log staff detection) with
// the assignees actually seen on reports. Users come from both sources — members give the complete
// roster, seen options supply friendlier display names where available — while groups only ever
// come from report data, since the API has no endpoint to enumerate them. Deduped by token value
// (username / group name) and sorted by label.
function buildAssigneeOptions(seen: AssigneeOption[], members: TeamMember[]): AssigneeOption[] {
	const byValue = new Map<string, AssigneeOption>();
	for (const option of seen) {
		if (option.type === "user" && isSystemUser(option.value)) continue;
		byValue.set(option.value, option);
	}
	for (const member of members) {
		if (isSystemUser(member.username) || byValue.has(member.username)) continue;
		byValue.set(member.username, {
			type: "user",
			value: member.username,
			label: member.username,
			profile_picture_url: null,
		});
	}
	return [...byValue.values()].sort((a, b) =>
		a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
	);
}

// A native <select> — fully keyboard- and screen-reader-accessible out of the box, unlike a
// hand-rolled combobox, and unlike <datalist> it actually renders in the macOS WKWebView. Option
// values are the API filter tokens (username for users, name for groups); users and groups are
// split into <optgroup>s for clarity.
function AssigneeSection({ options }: { options: AssigneeOption[] }) {
	const state = useAppState();
	const dispatch = useDispatch();
	const token = state.filters.assignees[0] ?? "";
	const users = options.filter((o) => o.type === "user");
	const groups = options.filter((o) => o.type === "group");
	// A token persisted from a previous session might no longer be in the accumulated options;
	// keep it selectable so the control reflects the active filter rather than silently blanking.
	const orphan = token && !options.some((o) => o.value === token) ? token : null;

	return (
		<div class="side-section">
			<div class="side-h">
				<span>Assignee</span>
			</div>
			<select
				class="assignee-select"
				value={token}
				onChange={(e) => {
					const value = e.currentTarget.value;
					dispatch({ type: "ASSIGNEES_SET", assignees: value ? [value] : [] });
				}}
			>
				<option value="">Any</option>
				{orphan ? <option value={orphan}>{orphan}</option> : null}
				{users.length > 0 ? (
					<optgroup label="Users">
						{users.map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</optgroup>
				) : null}
				{groups.length > 0 ? (
					<optgroup label="Groups">
						{groups.map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</optgroup>
				) : null}
			</select>
		</div>
	);
}

function InboxSection({ state }: { state: AsyncState<InboxRef[]> | undefined }) {
	if (!state || state.status !== "ready") {
		return (
			<div class="side-section">
				<div class="side-h">
					<label class="check-h">
						<input type="checkbox" class="cb" disabled />
						Inbox
					</label>
				</div>
				{!state || state.status === "idle" || state.status === "loading" ? (
					<div class="facet facet-muted">Loading…</div>
				) : (
					<div class="facet facet-muted">Couldn't load inboxes</div>
				)}
			</div>
		);
	}
	return <InboxSectionReady inboxes={state.data} />;
}

function InboxSectionReady({ inboxes }: { inboxes: InboxRef[] }) {
	const state = useAppState();
	const dispatch = useDispatch();
	const selected = state.filters.inboxes;
	const allIds = inboxes.map((i) => i.id);
	const checked = new Set<string>(selected);
	const allChecked = allIds.length > 0 && allIds.every((k) => checked.has(k));
	const someChecked = allIds.some((k) => checked.has(k));
	const parentRef = useIndeterminate(allChecked, someChecked);

	const toggleAll = () => {
		dispatch({ type: "INBOXES_SET", inboxes: someChecked ? [] : allIds });
	};
	const toggleOne = (id: string) => {
		const next = checked.has(id) ? selected.filter((k) => k !== id) : [...selected, id];
		dispatch({ type: "INBOXES_SET", inboxes: next });
	};

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
						disabled={inboxes.length === 0}
					/>
					Inbox
				</label>
			</div>
			{inboxes.length === 0 ? (
				<div class="facet facet-muted">No inboxes</div>
			) : (
				inboxes.map((inbox) => (
					<label key={inbox.id} class="facet">
						<input
							type="checkbox"
							class="cb"
							checked={checked.has(inbox.id)}
							onChange={() => toggleOne(inbox.id)}
						/>
						<span>{inbox.name}</span>
					</label>
				))
			)}
		</div>
	);
}

// Assets are identified by their identifier throughout — it's what reports carry and what the
// query filters on, so there's no id to key the checkboxes on.
function AssetSectionReady({ assets }: { assets: string[] }) {
	const state = useAppState();
	const dispatch = useDispatch();
	const selected = state.filters.assets;
	const checked = new Set<string>(selected);
	const allChecked = assets.length > 0 && assets.every((k) => checked.has(k));
	const someChecked = assets.some((k) => checked.has(k));
	const parentRef = useIndeterminate(allChecked, someChecked);

	const toggleAll = () => {
		dispatch({ type: "ASSETS_SET", assets: someChecked ? [] : assets });
	};
	const toggleOne = (identifier: string) => {
		const next = checked.has(identifier)
			? selected.filter((k) => k !== identifier)
			: [...selected, identifier];
		dispatch({ type: "ASSETS_SET", assets: next });
	};

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
						disabled={assets.length === 0}
					/>
					Asset
				</label>
			</div>
			{assets.length === 0 ? (
				<div class="facet facet-muted">No assets</div>
			) : (
				assets.map((asset) => (
					<label key={asset} class="facet facet-asset">
						<input
							type="checkbox"
							class="cb"
							checked={checked.has(asset)}
							onChange={() => toggleOne(asset)}
						/>
						<span>
							<AssetIdentifier identifier={asset} />
						</span>
					</label>
				))
			)}
		</div>
	);
}
