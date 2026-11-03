# Grok Bot specialist executor

Grok Bot exposes `POST /api/swarm/execute` only when the matching role-scoped `SWARM_EXECUTOR_<ROLE>_TOKEN` is configured. The endpoint selects one of four dedicated agents, runs it in the shared per-job sandbox workspace, records real tool exit status and output digests in CodeX, and signs the resulting role evidence with Ed25519. A role cannot pass without successful tool execution and its role-specific structured report.

## Provisioning

Create a dedicated executor key pair outside the repository:

```sh
mkdir -p secrets
openssl genpkey -algorithm Ed25519 -out secrets/grok-swarm-executor-ed25519.pem
openssl pkey -in secrets/grok-swarm-executor-ed25519.pem -pubout -out secrets/grok-swarm-executor-ed25519.pub
chmod 600 secrets/grok-swarm-executor-ed25519.pem
chmod 644 secrets/grok-swarm-executor-ed25519.pub
openssl rand -hex 32
```

Use the random value as the identical `SWARM_EXECUTOR_TOKEN` in Grok Bot and Swarm. Set `SWARM_EXECUTOR_SIGNING_KEY_FILE=/run/secrets/grok-swarm-executor-ed25519.pem` in Grok Bot and `SWARM_EXECUTOR_PUBLIC_KEY_FILE=/run/secrets/grok-swarm-executor.pub` in Swarm. The public key must be independently pinned by the coordinator. Do not commit either key or the token.

Create the shared network once:

```sh
docker network create swarm-integration
```

Set `SWARM_EXECUTOR_SIGNING_KEY_HOST_FILE` to the host path of the private key and start Grok Bot with the overlay:

```sh
docker compose -f docker-compose.yml -f docker-compose.swarm.yml up -d
```

Swarm's four role workers join the same external network and call `http://grok-bot:3000/api/swarm/execute`. The host-published Grok Bot port is loopback-bound by default; worker traffic remains on the isolated Docker network.

## Evidence policy

- Debugger: diagnosis + reproducible command, backed by a successful tool call.
- Coder: changed artifact paths + SHA-256 digests, backed by terminal execution.
- Tester: actual test commands and zero exit codes, backed by terminal execution.
- Governance: independent approval and all checks passing, backed by its own tool calls.
- Failed tool calls, missing reports, approval pauses, malformed output, and missing signing keys never become success.

The CodeX run ID is stable per job/role. A completed signed result is cached in the append-only run ledger so a worker retry returns the same evidence rather than rerunning completed work. If the agent process crashes before the result record is committed, the job may execute again; side-effecting commands must remain idempotent.

This is a model/tool execution adapter, not proof that a particular objective is correct. Governance must independently verify the actual artifact/test evidence.