# Crow OS × AVRONE × Grok Bot workspace

The second private workspace mirrors Grok Bot's dark Chat / Team / Runs / Ledger / Approvals interface and adds runtime configuration. The hosted workspace persists conversations, captured agent settings, jobs, and an append-only activity trail. The local bridge connects your actual installed runtimes with outbound HTTPS; it does not open local ports to the internet.

Workspace: https://crow-os-grok-workspace.sedateaphid32.chatgpt.site
Verification workspace: https://avrone-mission-workspace.sedateaphid32.chatgpt.site

## Connect an existing system

1. Sign in to the private workspace and open Configuration.
2. Download the Python bridge and private pairing JSON. Keep the pairing file outside Git.
3. Run: `python3 crow_bridge.py --config crow-bridge-private.json`.
4. Each runtime is checked independently: Grok Bot :3000, Crow OS :8787, AVRONE :8710, Ollama :11434. Select the desired engine in Chat.
5. Use “Import live host agents” to copy the observed current Grok/Crow agent configuration into workspace drafts. Models, tool grants, instructions, and runtime identity are captured with each mission.

For a separate local installation, keep `install_workspace.py` and `crow_bridge.py` together, then run:

```bash
python3 install_workspace.py --config /path/to/crow-bridge-private.json --install-ollama
```

The installer uses a separate `~/.crow-workspace/runtime`, reuses healthy installed services, checks exact source revisions, and can install Ollama through Homebrew on macOS. Use `--crow-home /path/to/existing/.crow-os` to reuse an existing Crow OS home and `--grok-config /path/to/agents.json` to import a Grok roster into the isolated checkout. These are explicit operator choices; the default creates a separate Crow OS home.

Grok Bot requires a working Docker daemon. The installer uses the upstream core Compose profile, binds published ports to loopback, waits for real boot self-tests, and runs its live tests. It does not manufacture a ready state when Docker, models, or a bridge are unavailable. A cold model/image pull can take substantial time. The bundled installer has not been run against the user's computer.

## Honest execution states

- Queued: saved request awaiting an available runtime; no model response is fabricated.
- Running: a fresh authenticated bridge has atomically claimed the job with a lease.
- Blocked: a dependency, approval, or uncertain execution needs attention.
- Completed: the provider returned a complete result; verification is still required.
- Failed: the provider or transport reported a definite failure.
- Unmerged / unverified: remain explicit for every proposed build result.

The bridge uses a WAL SQLite receipt file to refuse duplicate execution, even after restart. Interrupted Grok streams are not automatically replayed. Lease expiry marks execution uncertain. Resume creates another attempt with a parent link. A live tool approval must still match the pending tool and arguments when the bridge processes the user's decision.

Direct Ollama mode provides chat, without build tools. Grok Bot handles tool-capable chat and Squad/Deep builds; Crow OS remains behind its capability and ledger contracts. Runtime output is not acceptance evidence. The verification workspace retains the full-suite and acceptance gates.

## Source and validation

Exact source revisions are recorded in `source-locks.json`. The hosted UI mirrors the public Grok Bot UI at that revision; it does not claim the local OS or Ollama is installed merely because the Site is published.

```bash
python3 -m unittest discover -s integrations/crow-workspace -p 'test_*.py' -v
python3 -m py_compile integrations/crow-workspace/crow_bridge.py integrations/crow-workspace/install_workspace.py
```

The Site's source repository additionally contains its API integration tests, TypeScript checks, and build configuration. Unit tests use bounded fixtures and do not prove a real model, Docker boot, or the user's current local configuration.
