import type { BountyTotal } from "../state/store";

// Render a dollar amount as a compact string, e.g. "$450" or "$1,250.50". Whole amounts
// drop the decimals; fractional amounts keep cents.
export function formatMoney(amount: number): string {
	const fractionDigits = Number.isInteger(amount) ? 0 : 2;
	return `$${amount.toLocaleString(undefined, {
		minimumFractionDigits: fractionDigits,
		maximumFractionDigits: fractionDigits,
	})}`;
}

export function formatBounty(bounty: BountyTotal): string {
	return formatMoney(bounty.amount);
}
