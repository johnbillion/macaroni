import { Fragment } from "preact";

export function AssetIdentifier({ identifier }: { identifier: string }) {
	const parts = identifier.split(",").map((p) => p.trim());
	return (
		<>
			{parts.map((part, i) => (
				<Fragment key={i}>
					{i > 0 && <br />}
					{part}
				</Fragment>
			))}
		</>
	);
}
