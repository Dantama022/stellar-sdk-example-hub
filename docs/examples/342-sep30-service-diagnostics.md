# ISSUE-342 — SEP-30 service connectivity diagnostics

Run: `npm run run-example -- 342-sep30-service-diagnostics` with existing dependencies. The default uses a **mock** fetch, not a real service. Example output:

```json
{"reachable":true,"providerHealth":true,"sep30Compatible":null,"recoveryCompleted":false,"category":"ok","durationMs":0,"detail":"Provider-specific readiness probe passed; SEP-30 compatibility unverified"}
```

**SEP-30 defines authenticated account endpoints but no standard public health or capability endpoint.** A provider may publish a custom JSON GET readiness probe, for example `/health` responding with `{ "ok": true }`; this contract is **specific to this demo and not SEP-30**. The diagnostic checks only that explicit provider contract. A healthy response does not prove the service implements SEP-30, can authenticate an identity, can sign a recovery transaction, or can recover an account. If no provider probe is configured, the result is `unsupported`/unverified rather than a fabricated failure or success.

For a real **read-only provider probe only**, set `SEP30_LIVE_PROBE=true`, `SEP30_BASE_URL=https://your-test-service.example`, and `SEP30_PROVIDER_PROBE_PATH=/health`. URLs must be HTTPS, with local HTTP allowed only when the caller explicitly opts in. Requests time out. The example does not send JWTs or identities. Real SEP-30 operations require authentication, but they are **intentionally not part of this diagnostic** (see ISSUE-336 for that separate workflow). Failed health probes do not by themselves prove the whole service is down. No sensitive URL userinfo, body, or server-provided error messages appear in diagnostics.

Official protocol: [SEP-30](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0030.md).
