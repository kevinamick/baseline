/**
 * How many recent rows a Team-visible ledger list renders. The billing page
 * turns every returned row into a DOM node, so this bounds both the unindexed
 * tail of a period read and the rendered list size. The hottest case is
 * managed_spend_ledger, which takes one accrue row per metered LLM call, so an
 * active Team's period can hold thousands of rows. Period totals/balances are
 * derived separately (getPointBudget / getManagedSpendTotal), never by summing
 * these lists, so the cap can never skew a displayed total.
 */
export const LEDGER_DISPLAY_LIMIT = 250;
