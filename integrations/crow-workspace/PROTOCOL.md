# Outbound bridge protocol

The Site is owner-private. Browser changes require trusted ChatGPT identity and same-origin submissions. Pairing downloads additionally require the signed-in owner; pairing credentials are served without caching and never appear in public state or source.

Bridge operations require both the private Site dispatch bearer ****** an independently generated bridge key. Credentials are sent in headers only to the fixed Site origin. Runtime endpoints are constrained to loopback origins. The bridge never forwards Site credentials to a local model or service.

The bridge publishes a heartbeat from actual service health reads. A job can be claimed only when its selected runtime reports ready in a fresh heartbeat. Claim uses a conditional database version update. A random lease token binds subsequent activity and completion. Stale or wrong leases are rejected.

Progress extends the lease. A lease keeper reports that the runtime is still executing if a model is slow. The bridge writes an execution receipt before dispatch. The same job is never silently dispatched twice after a process restart. Model output is unverified data, not authority to merge or to bypass runtime capability/approval checks.

Approvals are separate queued operations created by an explicit owner decision. The bridge rereads the actual Grok pending approvals, compares the tool and arguments, and refuses a changed or missing action. Resume on an active or already queued request is refused. Resumed attempts retain their parent ID.

Runtime state is scoped to the last heartbeat. Repository configuration is separately identified as repository-derived, with commit URLs and no claim that it is the current installed host configuration.
