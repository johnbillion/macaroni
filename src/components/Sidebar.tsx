import { SeverityMeter } from "./SeverityMeter";

// All controls in this sidebar are visual placeholders for v1.
// Filtering will be wired up in a later pass — see the plan.
export function Sidebar() {
	return (
		<aside class="side">
			<div class="side-search">
				<div class="search-box">
					<input type="search" placeholder="search" />
				</div>
			</div>

			<div class="side-section">
				<div class="side-h">
					<span>VIEWS</span>
					<span>+</span>
				</div>
				<div class="view-item selected">
					<span class="glyph">★</span> My triage
				</div>
				<div class="view-item">
					<span class="glyph">○</span> Unassigned
				</div>
				<div class="view-item">
					<span class="glyph">◐</span> Awaiting reply
				</div>
				<div class="view-item">
					<span class="glyph">◉</span> SLA breached
				</div>
				<div class="view-item">
					<span class="glyph">⌖</span> Bounty pending
				</div>
			</div>

			<div class="side-section">
				<div class="side-h">
					<span>STATE</span>
				</div>

				<div class="cb-group">
					<label class="check-h">
						<input type="checkbox" class="cb" />
						Open
					</label>
					<label class="facet">
						<input type="checkbox" class="cb" defaultChecked />
						<span class="swatch state-new" /> New
					</label>
					<label class="facet">
						<input type="checkbox" class="cb" />
						<span class="swatch state-pending" /> Pending program review
					</label>
					<label class="facet">
						<input type="checkbox" class="cb" />
						<span class="swatch state-needs-info" /> Needs more info
					</label>
					<label class="facet">
						<input type="checkbox" class="cb" />
						<span class="swatch state-triaged" /> Triaged
					</label>
					<label class="facet">
						<input type="checkbox" class="cb" />
						<span class="swatch state-retesting" /> Retesting
					</label>
				</div>

				<div class="cb-group">
					<label class="check-h">
						<input type="checkbox" class="cb" />
						Closed
					</label>
					<label class="facet">
						<input type="checkbox" class="cb" />
						<span class="swatch state-duplicate" /> Duplicate
					</label>
					<label class="facet">
						<input type="checkbox" class="cb" />
						<span class="swatch state-informative" /> Informative
					</label>
					<label class="facet">
						<input type="checkbox" class="cb" />
						<span class="swatch state-na" /> N/A
					</label>
					<label class="facet">
						<input type="checkbox" class="cb" />
						<span class="swatch state-resolved" /> Resolved
					</label>
					<label class="facet">
						<input type="checkbox" class="cb" />
						<span class="swatch state-spam" /> Spam
					</label>
				</div>
			</div>

			<div class="side-section">
				<div class="side-h">
					<label class="check-h">
						<input type="checkbox" class="cb" />
						SEVERITY
					</label>
				</div>
				<label class="facet">
					<input type="checkbox" class="cb" defaultChecked />
					<SeverityMeter rating="critical" showLabel />
				</label>
				<label class="facet">
					<input type="checkbox" class="cb" defaultChecked />
					<SeverityMeter rating="high" showLabel />
				</label>
				<label class="facet">
					<input type="checkbox" class="cb" />
					<SeverityMeter rating="medium" showLabel />
				</label>
				<label class="facet">
					<input type="checkbox" class="cb" />
					<SeverityMeter rating="low" showLabel />
				</label>
				<label class="facet">
					<input type="checkbox" class="cb" />
					<SeverityMeter rating="none" showLabel />
				</label>
				<label class="facet">
					<input type="checkbox" class="cb" />
					<SeverityMeter rating={null} showLabel />
				</label>
			</div>
		</aside>
	);
}
