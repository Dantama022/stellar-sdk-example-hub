# SEP-9 and SEP-12 Customer Information Validation

This example validates a local JSON payload against the current SEP-9 field names and types and demonstrates how the accepted values can be separated for later SEP-12 preparation. It makes no network requests and does not persist input data.

## Run

Use fictional data by default:

```sh
npm install
npx ts-node src/examples/262-sep9-sep12-customer-information-validation.ts
```

Validate a local JSON file and print a machine-readable report:

```sh
npx ts-node src/examples/262-sep9-sep12-customer-information-validation.ts --file ./customer.json --json
```

The input shape is an object containing only a `fields` object. For example:

```json
{
  "fields": {
    "first_name": "Jordan",
    "email_address": "jordan@example.test",
    "birth_date": "1990-04-12"
  }
}
```

The example CLI configures `first_name` and `email_address` as required for demonstration. Override the list with `--required first_name,birth_date`, or use `--required ''` to configure none. SEP-9 itself does not designate universally required fields; actual requirements depend on the anchor, transaction, and customer type.

## Supported Fields

The validator schema follows the current SEP-9 tables, including field aliases. It recognizes:

- Natural person: `family_name`, `last_name`, `given_name`, `first_name`, `additional_name`, `address_country_code`, `state_or_province`, `city`, `postal_code`, `address`, `mobile_number`, `mobile_number_format`, `email_address`, `birth_date`, `birth_place`, `birth_country_code`, `tax_id`, `tax_id_name`, `occupation`, `employer_name`, `employer_address`, `language_code`, `id_type`, `id_country_code`, `id_issue_date`, `id_expiration_date`, `id_number`, `photo_id_front`, `photo_id_back`, `notary_approval_of_photo_id`, `ip_address`, `photo_proof_residence`, `sex`, `proof_of_income`, `proof_of_liveness`, `referral_id`.
- Financial account: `bank_name`, `bank_account_type`, `bank_account_number`, `bank_number`, `bank_phone_number`, `bank_branch_number`, `external_transfer_memo`, `clabe_number`, `cbu_number`, `cbu_alias`, `mobile_money_number`, `mobile_money_provider`, `crypto_address`, `crypto_memo` (deprecated by SEP-9).
- Organization: `organization.name`, `organization.VAT_number`, `organization.registration_number`, `organization.registration_date`, `organization.registered_address`, `organization.number_of_shareholders`, `organization.shareholder_name`, `organization.photo_incorporation_doc`, `organization.photo_proof_address`, `organization.address_country_code`, `organization.state_or_province`, `organization.city`, `organization.postal_code`, `organization.director_name`, `organization.website`, `organization.email`, `organization.phone`.
- Card: `card.number`, `card.expiration_date`, `card.cvc`, `card.holder_name`, `card.network`, `card.postal_code`, `card.country_code`, `card.state_or_province`, `card.city`, `card.address`, `card.token`.

## Validation Rules

- `string` fields must be non-empty strings; `number` fields must be finite JSON numbers.
- SEP-9 `date` fields use a valid `YYYY-MM-DD` calendar date, except `card.expiration_date`, which uses `YY-MM` with a valid month.
- JSON representations of SEP-9 `binary` fields must be non-empty standard base64 strings. SEP-12 specifies multipart form data for binary uploads, with binary fields submitted after other fields.
- Basic syntax checks apply to email addresses, IPv4/IPv6 addresses, HTTP(S) organization websites, and E.164 phone fields. `mobile_number_format: "hash"` disables the E.164 check on `mobile_number`; other explicit formats are left to the anchor.
- The schema checks the explicit ISO code shapes stated for `id_country_code` (three letters) and `card.country_code` (two letters). It does not resolve country codes or infer country-specific identity, tax, banking, address, or document-number rules.
- Unknown field names, invalid values, missing configured fields, and malformed structure are reported separately. Reports include field names and rule descriptions, never submitted values.

The payload contains only customer values. Descriptions and required-field policy belong in the validator schema/options, not inside customer input. A valid report means only that these local syntactic checks passed.

## SEP-12 Workflow Boundary

SEP-12 `GET /customer` allows a client to retrieve the anchor's requested fields and status. `PUT /customer` sends one or more SEP-9 fields plus SEP-12 identifiers/parameters under the anchor's authenticated workflow. The helper `prepareSep12CustomerFields` separates ordinary values from base64 binary values for an adapter to encode appropriately; the example intentionally defines no network adapter implementation, credentials, or submission call.

Anchors may require additional fields, define type-specific requirements, and apply service-specific checks. Local validation does not establish identity, verify documents, determine a customer's status, or decide legal/regulatory compliance. Never use this example as a complete KYC service or send real personal data through its demonstration path.

Specifications:

- [SEP-9: Standard KYC Fields](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0009.md)
- [SEP-12: KYC API](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md)

## Invalid Example

This fictional payload has an invalid email, a non-date birth date, and an unknown field. Diagnostics identify field names and rules without repeating submitted values:

```json
{
  "fields": {
    "email_address": "not-an-email",
    "birth_date": "not-a-date",
    "passport_id": "fictional"
  }
}
```