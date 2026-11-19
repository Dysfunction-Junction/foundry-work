# Foundry

> Working name. Status: **specification only, no code yet.** The documents in `docs/` are the build plan.

Foundry is a personal databank that runs on a computer you own. You point it at your data
exports (starting with Google Takeout), it encrypts everything into a vault on your disk,
keeps a second copy on a drive you choose, and lets you search your own history. Nothing is
uploaded anywhere. It costs nothing to run beyond hardware you already have.

## What it will do (v1)

1. **Setup wizard.** Asks where the databank lives and which drive holds the second copy,
   checks RAM and CPU, and sets a passphrase plus a printable recovery key.
2. **Guided import.** Walks you through requesting a Google Takeout export and imports the
   archive when it arrives. More sources follow the same pattern.
3. **Encrypted vault.** Raw data is stored once, encrypted, in append-only segments that are
   hash-chained so later changes are detectable.
4. **Search.** Full-text search over everything imported, on-device.
5. **Second copy.** An offline drive that is connected only for short, scheduled sessions
   and sealed afterwards (v1), or an always-on device on your own network (later).

## What it will not do

- No cloud service, no account, no telemetry.
- No promise that a language model never makes things up. The promise is narrower: answers
  cite a stored record or say "not found".
- No promise that a drive lasts forever. The vault detects tampering and damage; it does
  not prevent fire, loss or wear. That is why a second copy and scheduled checks are built in.

## Platforms

Windows 10/11 and Linux (x64) in v1. macOS is deferred.

| Tier | Machine | What runs |
|---|---|---|
| 0 | 4 GiB RAM | Vault, import, full-text search. No language model. |
| 1 | 8 GiB RAM, 4 cores | Tier 0 plus on-demand embeddings and a small local model. |
| 2 | 16 GiB RAM or a GPU | Tier 1 plus a larger model and an answer verifier. |

## Documents

| Document | Read it when |
|---|---|
| [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) | You want to know what the product does and for whom. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | You are building the vault, index, importers or wizard. |
| [docs/STEP_ZERO_FACTS_LEDGER.md](docs/STEP_ZERO_FACTS_LEDGER.md) | You are building the first deliverable. |
| [docs/ROADMAP.md](docs/ROADMAP.md) | You are picking up a work package. |
| [docs/DECISIONS.md](docs/DECISIONS.md) | You want to know what is settled, assumed, or still open. |

## Build order

Step Zero (the verified facts ledger) is built first, because the agents that build the
rest use it to stop guessing. Then the thin slice: Takeout archive in, encrypted vault,
search out. Then the wizard, the second copy, and more sources.

## License

MIT. See [LICENSE](LICENSE).
