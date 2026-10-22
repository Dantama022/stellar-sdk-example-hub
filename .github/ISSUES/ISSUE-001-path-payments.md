# ISSUE-001: Implement Path Payments Example (Horizon)

**EPIC:** SDK Examples

**Labels:** enhancement, good first issue, easy, wave

**Difficulty:** Easy

## Description

Stellar supports path payments, allowing a sender to pay with one asset while the recipient receives another through available DEX liquidity paths.

Implement a runnable SDK example demonstrating how to discover available paths, construct a path payment transaction, and submit it successfully using Horizon.

## Tasks

* [ ] Create `src/examples/06-path-payment.ts`
* [ ] Implement either `Operation.pathPaymentStrictSend` or `Operation.pathPaymentStrictReceive`
* [ ] Query Horizon for available payment paths
* [ ] Execute the path payment transaction
* [ ] Display exchange rate information
* [ ] Display transaction hash upon successful submission
* [ ] Register the example in the runner catalog
* [ ] Add documentation explaining how path payments work

## Acceptance Criteria

* Running `npm run run-example 06-path-payment` executes successfully
* Example runs against Stellar Testnet
* Transaction hash is displayed after successful execution
* Exchange rate information is displayed
* Inline documentation explains path payments, liquidity routes, and limits
* Example is discoverable through the example runner

## Files Likely Affected

* `src/examples/06-path-payment.ts`
* `src/runner/catalog.ts`
* `README.md`

## Testing Requirements

* Example executes successfully on Stellar Testnet
* Transaction hash is displayed
* Exchange rate information is displayed
* Example passes CI validation

## References

* Stellar Path Payments Documentation
* Stellar JavaScript SDK Documentation

## Estimated Effort

3–5 hours
