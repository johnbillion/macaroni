import type { BountyTotal } from "../state/store";

// Render a money amount as a compact string, e.g. "$450" or "€1,250". Whole amounts
// drop the decimals; fractional amounts keep cents. Falls back to a plain formatted
// number when the currency code is missing or not recognised by Intl.
export function formatMoney(amount: number, currency: string | null): string {
	const fractionDigits = Number.isInteger(amount) ? 0 : 2;
	if (currency) {
		try {
			return new Intl.NumberFormat(undefined, {
				style: "currency",
				currency,
				// Prefer the bare symbol ("$") over the locale-disambiguated form ("US$").
				currencyDisplay: "narrowSymbol",
				minimumFractionDigits: fractionDigits,
				maximumFractionDigits: fractionDigits,
			}).format(amount);
		} catch {
			// Unknown currency code — fall through to a plain formatted number.
		}
	}
	return amount.toLocaleString(undefined, {
		minimumFractionDigits: fractionDigits,
		maximumFractionDigits: fractionDigits,
	});
}

// Render an awarded bounty (amount + currency) as a compact currency string.
export function formatBounty(bounty: BountyTotal): string {
	return formatMoney(bounty.amount, bounty.currency);
}
