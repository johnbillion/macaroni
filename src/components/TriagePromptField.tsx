// The triage prompt editor. Purely controlled: the Settings dialog owns the draft and persists
// it with everything else when the dialog is saved, so there's no save button of its own.
type Props = {
	value: string | null;
	defaultPrompt: string | null;
	disabled: boolean;
	onChange: (value: string) => void;
};

export function TriagePromptField({ value, defaultPrompt, disabled, onChange }: Props) {
	const isDefault = value != null && value === defaultPrompt;

	return (
		<div class="prompt-field">
			<label>
				<span>Triage prompt</span>
				<textarea
					class="prompt-field-input"
					rows={10}
					spellcheck={false}
					value={value ?? ""}
					disabled={disabled || value == null}
					onInput={(e) => onChange(e.currentTarget.value)}
				/>
			</label>
			<div class="prompt-field-row">
				<span class="prompt-field-status">
					{isDefault ? "Using the default prompt" : "Customised"}
				</span>
				{!isDefault && defaultPrompt != null ? (
					<button
						type="button"
						class="button"
						onClick={() => onChange(defaultPrompt)}
						disabled={disabled}
					>
						Reset to default
					</button>
				) : null}
			</div>
		</div>
	);
}
