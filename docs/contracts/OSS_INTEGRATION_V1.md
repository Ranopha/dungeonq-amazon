# Independent MCP consumer contract v1

Owner: DungeonQ repository owner. Schemas: `dungeonq.shipping-consumer/v1` and `dungeonq.oss-integration/v1`. Compatible with the Runtime v1 participant-v1 presentation; runtime authority and persistence schemas are unchanged.

- The consumer imports only Node built-ins and the official MCP SDK. Inputs are actor endpoint/token and non-authority execution options. It receives no operator/origin/witness capability and reads no credential bundle or private runtime implementation.
- Real MCP operations perform shipping review, write, separate readback and one-use world-ticket access. Shipping is not executed. Consumer success does not establish origin protection, human approval or outside adoption.
- The harness owns separate operator/origin fixtures. Only setup imports the reference factory; observation, preview/apply, ordinary control and witness reads use public protocols. An explicit APPLY grants at most eight follow-ups over one hour; this example consumes one.
- The child has a sanitized environment, filesystem read allowlists and no write/subprocess grant. A probe under the same launch policy must reject fixture credential reads. This constrains a cooperative program on a trusted local host; it is not hostile-code or OS isolation.
- Reports retain version, eight stable scenes, minimal route events, origin before/after digests and an admission interval. They omit credentials, raw tickets, endpoints and temporary paths.
- Missing credentials, incompatible protocols/fixtures, operator failure, unknown outcomes and incomplete evidence cannot PASS. A previous write may survive failure; no automatic rollback is claimed. Exclusive creation prevents report overwrite.
- `tests/oss-integration.test.mjs` verifies compatibility, authority and failure behavior. Live AI, external adoption, production protection and service restart require separate evidence.

Recovery: this addition is a separate package, harness, tests and documents. The harness removes only the artificial fixture it created. Existing-reference users retain their own data and operator policies; consumer exit does not delete or roll back that installation.
