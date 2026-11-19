# Foundry architecture

Status: draft for build, 2026-11-19. Byte-level formats in this document are **draft v0**:
work package V-1 in [ROADMAP.md](ROADMAP.md) freezes them with test vectors. Until then a
builder may change a layout detail if the change is recorded in [DECISIONS.md](DECISIONS.md).

Terms used throughout:

| Term | Meaning |
|---|---|
| Vault | The append-only, encrypted store of raw data. The source of truth. |
| Segment | A directory of vault files that is written, then closed, then never changed. |
| Close | Write a segment's manifest and extend the hash chain. Happens on the working device. |
| Seal | Copy a closed segment to the second copy, verify it there, mark it read-only, record the result. |
| Index | The derived SQLite database on the working device. Rebuildable from the vault. |
| Working device | The computer the user installs Foundry on. |
| Chain head | `(vault_id, segment number, manifest hash)` of the newest closed segment. |

## 1. System overview

```
 data exports ──► importers ──► VAULT (append-only, encrypted, hash-chained segments)
 (zip archives)                   │                         │
                                  │ replay                  │ vault session (Mode B)
                                  ▼                         ▼
                              INDEX (derived SQLite:    SECOND COPY (offline drive,
                              full text, vectors,       sealed segments, chain head)
                              places, graph, layout)
                                  │
                                  ▼
                        search / ask / map  ◄── `foundry` CLI and the loopback wizard
```

Three rules hold everywhere:

1. Only importers and annotation commands write to the vault, and only by appending.
2. Everything in the index can be deleted and rebuilt from the vault plus the keyring.
3. No process outlives its task. There is no daemon.

## 2. Packages

One repository, one workspace. Runtime target: Node.js 24 LTS or newer (pinned in
`package.json` `engines` and in the shipped bundle). TypeScript, ES modules.

| Package | Responsibility | May depend on |
|---|---|---|
| `packages/facts-ledger` | Step Zero. See [STEP_ZERO_FACTS_LEDGER.md](STEP_ZERO_FACTS_LEDGER.md). | Nothing in this repo |
| `packages/vault` | Segment format, record encryption, keyring, chain, verify, seal | Node built-ins only |
| `packages/index` | SQL driver port, schema, projections, search | `vault` |
| `packages/importers` | Archive reader and per-source importers and derivers | `vault`, `index` |
| `packages/profiles` | Profiles, collections, consent, sensitivity rules | `vault` |
| `packages/cli` | The `foundry` command | all of the above |
| `packages/wizard` | Loopback web UI: static assets plus a server that lives only while open | `cli` internals |

Dependency policy: `vault` and `facts-ledger` have zero runtime npm dependencies. Every
other runtime dependency needs a line in `docs/DEPENDENCIES.md` (name, license, why it
cannot be avoided). Licenses must be MIT, BSD, ISC or Apache-2.0.

## 3. What is in the vault and what is derived

| In the vault (append-only) | Derived in the index (rebuildable) |
|---|---|
| Original bytes of every imported file or message | Extracted text and chunks |
| One event per imported item: source, original path, type, size, timestamps, blob reference | Full-text index |
| Tags and labels known at write time | Embeddings |
| Later annotations, corrections and redactions, each as a new event | Places table and spatial index |
| Consent notes, key-destruction notices, seal and drill records | Graph nodes and edges |
| Map node ids and placements (`node.created`, `layout.placed`) | Graph positions table |

A parser improvement never touches the vault: bump the deriver version and re-derive.

## 4. Vault format

### 4.1 Layout on disk

```
<vault>/
  VAULT.json                 clear text, written once: format, vault_id, created_at
  HEAD.json                  convenience copy of the chain head. Never trusted on its own.
  keyring/keyring.json       the only mutable file that holds key material (section 5.4)
  segments/
    000001/
      MANIFEST.json          clear text, written when the segment closes
      MANIFEST.sig           signature over MANIFEST.json (section 4.5)
      events-0001.fvr        record stream: events
      pack-0001.fvr          record stream: blobs
    000002/ ...
  open/                      the segment being written. Same files, no manifest yet.
```

- File names are lowercase ASCII so the vault copies cleanly to exFAT, NTFS and ext4.
- A record stream file rolls over at 64 MiB. A blob never spans two files; a blob larger
  than 64 MiB gets a file to itself. (**Decided:** segment soft cap 512 MiB.)
- The cap is soft. A blob larger than the cap gets a segment to itself, and that segment is
  as large as the blob. Blobs are never split, so there is no part order to authenticate.
  The cost: a second-copy drive must use a file system without a 4 GiB file limit (exFAT,
  NTFS, ext4 and similar). The wizard refuses FAT32 and offers to explain reformatting.
- Small items are packed into shared files on purpose. One file per email would waste most
  of a flash drive to cluster slack and make copies slow.

### 4.2 Record

Events and blobs use one record layout. An event is a record whose plaintext is one JSON document.

```
offset  size  field
0       4     magic "FVR1"
4       1     type: 1 = event, 2 = blob
5       16    key_id (which collection key encrypts this record)
21      32    salt (random per record)
53      8     ctx: u64 big-endian. Event sequence number for events, 0 for blobs.
61      8     total_len: u64 big-endian, bytes from offset 69 to the end of the record
69      ...   frames: u32 big-endian ciphertext_len | ciphertext | 16-byte tag
```

- Cipher: AES-256-GCM. Plaintext is cut into 1 MiB frames.
- Record key: `HKDF-SHA256(ikm = collection encryption key, salt = salt, info = "foundry/record-key/v1")`.
  Every record has its own key, so the frame nonce is `4 zero bytes || u64 frame index`.
- Additional authenticated data for each frame: `header (bytes 0..68) || vault_id (16 bytes) ||
  frame index (u64) || final flag (1 byte)`. The last frame has the final flag set.
  Truncation, reordering, a swapped header and replay into another vault all fail authentication.
- This is the construction already proven in the private predecessor (per-record salted key,
  header bound into every frame, final-frame flag), extended with `key_id`, `ctx`,
  `total_len` and the vault binding. It is a new format with new HKDF labels, not a
  compatible continuation; see section 14.
- `total_len` lets a reader walk a file and check structure without any key.

### 4.3 Event plaintext

```json
{
  "seq": 48211,
  "ts": "2026-11-19T16:40:00Z",
  "kind": "item.imported",
  "profile": "me",
  "collection": "c_7f3a…",
  "sensitivity": "personal",
  "source": "google-takeout/mail",
  "tags": ["inbox"],
  "body": { "blob": "<blob id>", "path": "Takeout/Mail/All mail.mbox#1042", "mime": "message/rfc822", "size": 18233, "source_ts": "2019-03-02T08:15:00Z" }
}
```

`seq` is a vault-wide counter with no gaps. Event kinds in v1:

| Kind | Purpose |
|---|---|
| `vault.created`, `profile.created`, `collection.created` | Structure |
| `item.imported` | One stored item and its blob reference |
| `annotation.added` | Tag or label added after the fact |
| `correction.applied` | `target_ref`, `field`, `new_ref`, `reason`. Points at records, never carries the corrected content inline. |
| `redaction.applied` | Hide one item from every projection. Carries a tombstone (section 5.7) so a re-import of the same bytes is refused. |
| `consent.recorded`, `consent.withdrawn` | Section 5.7 and the product spec |
| `key.destroyed` | Notice that a key was erased: key id, date, reason. No content. |
| `node.created` | A person, place or topic entered the map: random node id, kind, canonical key. Recorded once so the id survives later changes to how names are normalised. |
| `edge.inferred` | A relationship proposed by a model: endpoints, evidence, confidence, model id and version. Recorded once so a rebuild never re-runs inference. |
| `layout.placed`, `layout.moved`, `layout.epoch`, `node.merged` | Section 11 |
| `copy.sealed`, `drill.completed` | Second-copy history: counts and hashes only |

Structural and history events use a `system` collection key.

### 4.4 Blob identity

`blob id = HMAC-SHA256(collection id key, plaintext)`, 64 hex characters. Identical content
inside one collection is stored once. The id key is per collection so that destroying a
collection's keys also destroys the ability to confirm what a given blob contained.
Content is not deduplicated across collections; that is the price.

The blob id is stored inside the encrypted event, not in the clear record header.

### 4.5 Manifest and chain

`MANIFEST.json` is canonical JSON (RFC 8785): UTF-8, sorted keys, no extra whitespace,
integers only.

```json
{
  "format": "foundry-segment/1",
  "vault_id": "<32 hex>",
  "epoch": 1,
  "segment": 12,
  "prev_manifest_sha256": "<64 hex; 64 zeros for segment 1>",
  "first_event_seq": 48211,
  "last_event_seq": 50977,
  "files": [
    { "name": "events-0001.fvr", "bytes": 1048576, "sha256": "<64 hex>" },
    { "name": "pack-0001.fvr", "bytes": 67108864, "sha256": "<64 hex>" }
  ],
  "key_ids": ["<32 hex>", "<32 hex>"],
  "closed_at": "2026-11-19T00:00:00Z",
  "writer": "foundry 0.1.0"
}
```

- Manifest hash = SHA-256 of the file's bytes. Each manifest names the previous one's hash.
  Segment numbers and event sequence ranges are contiguous from one manifest to the next.
- `MANIFEST.sig` is an Ed25519 signature over the manifest bytes. The vault's public key
  is in `VAULT.json` and its fingerprint is part of the printed anchor (section 8.1). The
  private key is wrapped in the keyring like any other key. Without the signature, someone
  holding a drive could drop records and recompute a consistent chain, and a check that
  runs without keys would not notice.
- **Verification needs no secret.** `foundry vault verify` hashes every file, compares to
  the manifests, checks each signature against the public key, walks the chain from
  segment 1, and checks record structure. This is what scheduled jobs run.
- `foundry vault verify --deep` additionally needs the passphrase: it authenticates every
  frame of every record and checks that event sequence numbers have no gaps.
- `epoch` is 1 in v1. It is reserved so that a later "compact" command can write a new
  chain that leaves out erased ciphertext and names the head of the chain it replaces.
- What the clear manifest reveals to someone holding the drive: number and size of files,
  when segments were closed, how many distinct keys were used. It does not reveal names,
  content, sources or blob ids. Stated in the threat model.

### 4.6 Closing and crash safety

- Appends go to `open/`. Each record is written with a single write call and fsynced at
  the end of an import batch.
- On start, a writer scans the tail of `open/`. A final record shorter than its
  `total_len` is truncated away and reported.
- Close: fsync files, write `MANIFEST.json` to a temp name, fsync, rename `open/` to
  `segments/<n>/`, update `HEAD.json`. Closed segments are set read-only as a courtesy;
  this is not a security control.
- A segment closes when it reaches the soft cap, when a vault session starts, or on demand.

### 4.7 Reading the vault without Foundry

Work package V-1 ships a reference reader in Python, standard library plus one widely
packaged crypto module, under 200 lines, that decrypts a vault given the keyring and
passphrase. It runs in CI against the same test vectors. An archive meant to last decades
must not depend on one implementation.

## 5. Keys, encryption and erasure

### 5.1 Hierarchy

```
passphrase ──scrypt──► KEK ─┐
                            ├─ unwraps ─► master key MK (random, 32 bytes)
recovery key ──HKDF──► RK ──┘                 │ wraps
                                              ▼
                                   profile key PK (random, one per profile)
                                              │ wraps
                                              ▼
                                   collection key CK (random, one per collection and epoch)
                                              │ HKDF
                              ┌───────────────┼────────────────┐
                              ▼               ▼                ▼
                     encryption key      id key (HMAC)    (reserved)
```

- "Wraps" means AES-256-GCM encryption of the child key under the parent, with the child's
  key id and kind as additional authenticated data.
- Collection keys are random, not derived from MK. That is what makes erasure possible:
  a derived key can always be re-derived.
- The index key is also random and wrapped by MK, one per index generation. Rebuilding the
  index after an erasure creates a new generation under a new key and destroys the old one,
  so leftover pages of the old index file are unreadable.
- The manifest signing key (Ed25519) is random and wrapped by MK.
- Every use of a key has its own derivation label. No key is used for two purposes.
- Secrets are read from a terminal prompt or the wizard form. They are never accepted on
  the command line or from environment variables, and never written to logs.

### 5.2 Passphrase

scrypt with N = 2^17, r = 8, p = 1 and a 32-byte random salt. Parameters and salt are
stored in the keyring header so they can be raised later. Unlocking needs about 128 MiB
for under two seconds on a Tier 0 machine; see the budgets in section 9. The keyring has a
`kdf` field so a later version can move to Argon2id once the runtime's implementation is stable.

- The call passes an explicit memory limit. A reader rejects a keyring whose parameters
  are below the shipped floor or above a fixed ceiling **before** running the KDF, so a
  tampered keyring can neither weaken the passphrase nor exhaust memory.
- Parameters are never lowered silently. A change of KDF is a keyring rewrite the user confirms.

### 5.3 Recovery key

256 random bits, shown once as grouped base32 text and as a QR code for printing. It
unwraps MK independently of the passphrase. The wizard asks the user to type back four
groups before it continues. Changing the passphrase re-wraps MK and leaves the recovery key valid.

- The text form carries a version character and a checksum, so a typing mistake is
  reported as a mistake and not as a wrong key.
- The wizard warns before printing: "print to PDF" saves the key as a file, and network
  or cloud printers keep copies of what they print. Writing it down by hand is offered first.
- The recovery key is useless without a keyring file. The restore drill proves the pair
  works using only what is on the second copy.
- Changing the passphrase does not revoke an old one. Anyone who copied an earlier keyring
  and knows the earlier passphrase can still unwrap the keys that keyring held. After a
  suspected passphrase leak the remedy is `foundry vault rekey --all`, not a passphrase change.

### 5.4 Keyring file

A small JSON file. It is the only mutable file with key material and the only thing that
must be kept in step across copies.

```json
{
  "format": "foundry-keyring/1",
  "vault_id": "<32 hex>",
  "version": 41,
  "kdf": { "name": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<base64>" },
  "master": { "by_passphrase": "<base64>", "by_recovery": "<base64>" },
  "keys": [
    { "key_id": "<32 hex>", "kind": "profile", "parent": "master", "label_enc": "<base64>", "wrapped": "<base64>", "state": "active", "created_at": "…" },
    { "key_id": "<32 hex>", "kind": "collection", "parent": "<profile key id>", "wrapped": "<base64>", "state": "active", "created_at": "…" },
    { "key_id": "<32 hex>", "kind": "collection", "parent": "<profile key id>", "wrapped": null, "state": "destroyed", "destroyed_at": "…" }
  ],
  "mac": "<HMAC over the canonical file without this field, keyed from MK>"
}
```

- Writes are atomic (temp file, fsync, rename) and bump `version`.
- Every wrap authenticates, as additional data: format, vault id, key id, kind, parent and,
  for the two master wraps, the KDF parameters. A wrap moved to another slot or another
  vault fails to open.
- Entries of kind `index` (one per index generation) and `signing` follow the same shape.
- Size: keys exist per profile and per collection, never per item, so the file stays in
  the tens of kilobytes. A design with a random key per item was rejected for v1: it needs
  a transactional key store and makes every keyring backup a larger erasure liability.
- Default collection grain: one collection per profile, source and calendar year. That
  bounds the cost of re-keying after a single-item erasure to one source-year.
- The working device keeps a register of every keyring copy Foundry has written: which
  second copy, which keyring version, when. `foundry erase` prints the copies that still
  hold the old key.
- A destroyed key keeps its entry with `wrapped: null`, so a reader that meets a record
  under that key reports "erased on <date>" instead of "corrupt".
- Losing every copy of the keyring loses the data, even with the passphrase, because
  collection keys are random. Therefore: the keyring is written to every rewritable copy
  during each vault session, and the restore drill fails if the copy's keyring cannot open
  a sample record for every active key.
- The keyring is **not** written to write-once media by default. A key burned to a disc
  can never be destroyed, which would defeat erasure. A user who values durability over
  erasure can opt in; the wizard explains the trade.

### 5.5 Working index encryption (Decided: SQLCipher, option A)

The index holds extracted plaintext, so it is encrypted at rest.

- Access goes through a `SqlDriver` port with two adapters.
  1. `sqlcipher` (default): `better-sqlite3-multiple-ciphers`, opened with the raw index
     key (no per-open passphrase stretching), `temp_store = MEMORY`, `secure_delete = ON`.
  2. `plain`: the runtime's built-in `node:sqlite`. Allowed only when the operating system
     reports full-disk encryption for the index volume **and** the user accepts it explicitly.
- The cipher scheme and its parameters are selected explicitly and pinned in code, never
  left to the library's defaults, and are set before the first schema access. The scheme
  must authenticate pages. Compatibility with other SQLCipher tools is not promised.
- **Fail closed.** If the SQLCipher adapter cannot load, or the key or format is rejected,
  the product stops with an explanation. It never falls back to an unencrypted index on its own.
- Startup self-check: the opened database must have FTS5 and R-tree compiled in.
- Tests run against the **shipped** binary on each platform: a wrong key fails; a modified
  page is rejected; a process killed mid-write recovers with a live write-ahead log; and a
  planted marker string is absent from the database file, the write-ahead log, journals
  and any spill file.
- Operating-system disk encryption is recommended as well. It protects swap, crash dumps
  and temp files that the database layer does not control.
- The native addon is the main packaging risk. CI must prove prebuilt binaries load on
  win32-x64 and linux-x64 (and linux-arm64 before Mode A ships) for the pinned Node version.
  A Node major upgrade is a deliberate change with that CI proof, never automatic.

### 5.6 Unlocking without a daemon

There is no agent process holding keys. A `KeyCache` port offers three behaviours:

| Adapter | Behaviour |
|---|---|
| `none` (default) | Ask for the passphrase on every command that needs to decrypt |
| `os-session` | Linux kernel keyring with a timeout; gone at logout |
| `os-protected` | Windows per-user data protection; survives reboot, tied to the user account |

Caching means anyone who can run code as the user can read the vault while the cache is
live. The wizard says this in one sentence when offering it. Scheduled jobs need no key:
they remind, and they verify ciphertext. The adapters are a spike (work package V-6);
`none` always works.

### 5.7 Erasure and its limits

Append-only storage and "delete my data" are reconciled by destroying keys.

| Request | Mechanism | Effect |
|---|---|---|
| Erase a profile | Destroy the profile key and all its collection keys in the keyring; append `key.destroyed`; purge the profile's rows from the index and vacuum | Every copy of that data, sealed or not, is unreadable once every keyring copy is updated |
| Erase a collection | Same, for one collection key | Same, narrower |
| Erase one item | Append `redaction.applied` (hidden from all projections at once). Physical removal needs `foundry vault rekey <collection>`: remaining items are re-encrypted under a new collection key into new segments and the old key is destroyed | Hidden immediately; unreadable after the re-key |

Order of operations. Each step is durable before the next starts, and an interrupted
erasure resumes from the first step not yet recorded:

1. Append the withdrawal (`consent.withdrawn`, `redaction.applied` or `key.destroyed`).
   From this point every read path refuses the data and the importer refuses to bring it back.
2. Destroy the keys in the working keyring.
3. Purge the index: text, full-text terms, vectors, places, graph evidence, inferred edges
   that rested on that evidence, and positions of nodes left with no evidence. Then
   rebuild into a new index generation and destroy the old index key.
4. At the next vault session for each second copy, update its keyring.

The interface reports three separate states per erasure and never merges them into one
word: **hidden** (step 1 done), **removed from the index** (step 3 done), and **key
destroyed on N of M copies** (steps 2 and 4).

**Restore rule.** A rebuild or restore first reads every withdrawal, redaction and
key-destruction event in the vault, and only then makes any item searchable. Restoring an
old copy can therefore never bring withdrawn data back into view. If a copy is older than
the newest withdrawal known to the working device, the product says so before it opens the copy.

**Tombstones.** `redaction.applied` stores `HMAC(tombstone key, original bytes)`, where the
tombstone key is derived from MK. The importer checks new items against the tombstones, so
re-importing the same archive does not restore a redacted item. The trade: the vault's
owner can later confirm that a given file was once redacted. Erasing a whole profile
records no per-item tombstones.

**Items about more than one person.** A photo or a conversation is stored once, in the
collection of the profile that imported it. A per-profile key cannot erase it for one
person and keep it for another. When someone other than the importer withdraws, their
request is met item by item: redaction at once, then re-key of that collection.

Limits, to be printed in the docs and shown in the erase dialog:

1. Erasure is only as complete as the destruction of every copy of the key. An old keyring
   on a forgotten backup, or burned to write-once media, keeps the data readable to anyone
   who also has the passphrase or recovery key. Copies Foundry did not make are invisible
   to it: file-history and shadow-copy features of the operating system, and the version
   history of a cloud-sync folder. The wizard warns when the vault folder is inside one.
2. Flash storage may retain old blocks of an overwritten keyring. Someone with the
   passphrase and forensic tools is not ruled out. Erasure removes the data from the
   product's reach; it is not a forensic guarantee.
3. Ciphertext of erased data stays in sealed segments forever. Its size and the fact that
   it existed remain visible.
4. Data already copied out of Foundry (exports, screenshots, model prompts sent elsewhere
   by the user) is outside its control.
5. Erasing one item by re-key costs a rewrite of that collection.
6. The person who asked cannot check it. The vault's owner holds the keys, so erasure is
   the owner's act and the owner's word. Foundry provides a technical property. It does
   not provide proof to a third party or compliance with any particular law.

## 6. Index

### 6.1 Schema

The predecessor's proven tables carry over with generic names: `meta`, `items`, `chunks`,
`chunks_fts` (FTS5, `porter unicode61`, external content with insert and delete triggers),
`vectors` (int8-quantised, one row per chunk, with `model`, `dim`, `scale`). `items` gains
`profile`, `collection` and `event_seq`. New tables:

```sql
CREATE TABLE projection_state (          -- how far each projection has replayed the vault
  projection TEXT PRIMARY KEY,
  deriver_version INTEGER NOT NULL,
  last_event_seq INTEGER NOT NULL
) STRICT;

CREATE TABLE blob_locator (              -- where each blob lives; rebuilt by scanning segments
  blob_id TEXT NOT NULL, collection TEXT NOT NULL,
  segment INTEGER NOT NULL, file TEXT NOT NULL, offset INTEGER NOT NULL, length INTEGER NOT NULL,
  PRIMARY KEY (collection, blob_id)
) STRICT;

CREATE TABLE places (
  place_id INTEGER PRIMARY KEY, item_id TEXT NOT NULL, ts INTEGER NOT NULL,
  lat_e7 INTEGER NOT NULL, lng_e7 INTEGER NOT NULL, accuracy_m INTEGER
) STRICT;
CREATE VIRTUAL TABLE places_rtree USING rtree_i32(place_id, min_lat, max_lat, min_lng, max_lng);

CREATE TABLE graph_nodes (
  node_id TEXT PRIMARY KEY,              -- random, assigned by a `node.created` event
  kind TEXT NOT NULL, canonical_key TEXT NOT NULL, label TEXT NOT NULL, profile TEXT,
  merged_into TEXT REFERENCES graph_nodes(node_id),
  UNIQUE (kind, canonical_key)
) STRICT;
CREATE TABLE graph_edges (
  edge_id INTEGER PRIMARY KEY,
  src TEXT NOT NULL REFERENCES graph_nodes(node_id),
  dst TEXT NOT NULL REFERENCES graph_nodes(node_id),
  kind TEXT NOT NULL,
  evidence_event_seq INTEGER NOT NULL,   -- earliest surviving evidence. No evidence, no edge.
  inferred INTEGER NOT NULL DEFAULT 0 CHECK (inferred IN (0,1)),
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK (inferred = 0 OR confidence IS NOT NULL)
) STRICT;
CREATE TABLE graph_edge_evidence (       -- every record that supports an edge
  edge_id INTEGER NOT NULL REFERENCES graph_edges(edge_id),
  event_seq INTEGER NOT NULL,
  PRIMARY KEY (edge_id, event_seq)
) STRICT;                                -- an edge whose last evidence row is removed is deleted
CREATE TABLE graph_positions (
  node_id TEXT PRIMARY KEY REFERENCES graph_nodes(node_id),
  epoch INTEGER NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL DEFAULT 0,
  placed_event_seq INTEGER NOT NULL
) STRICT;
```

### 6.2 Rebuild

`foundry index rebuild` builds a new index generation under a new key and replays the vault
in two passes. Pass one reads only withdrawals, redactions and key destructions and builds
the list of what must stay hidden (the restore rule in section 5.7). Pass two replays
everything else in `seq` order: events first, then derivers over blobs. The new generation
replaces the old one only when pass two has finished; the old index key is then destroyed.
Each projection records its progress, so an interrupted rebuild resumes. Records under a
destroyed key are skipped and counted. To shorten recovery after losing the working
device, a vault session may also write an encrypted index snapshot to the second copy; it
is a convenience, never a source of truth.

### 6.3 Search

1. Full text: FTS5 with BM25, filters on date, source, profile, collection, tier.
2. Semantic (Tier 1+): brute-force scan of int8 vectors. The predecessor measured roughly a
   third of a second over about fifty thousand chunks on a two-core low-power CPU; the
   number must be re-measured here before it is quoted anywhere.
3. Results always carry `item_id`, `event_seq`, source and import date so an answer can cite them.

## 7. Importers

```ts
interface ArchiveEntry { path: string; size: number; open(): Readable }

interface Importer {
  id: string;                                   // "google-takeout/mail"
  matches(entry: ArchiveEntry): boolean;
  split(entry: ArchiveEntry): AsyncIterable<RawItem>;   // lossless: originals only
}
interface RawItem { bytes: Readable; path: string; mime: string; sourceTs?: string; tags: string[] }

interface Deriver {
  id: string; version: number;
  derive(item: StoredItem, bytes: Readable): AsyncIterable<Derived>;  // text, places, graph evidence
}
```

- **Two stages on purpose.** `split` only cuts an archive into original items (one email,
  one contact card, one calendar file). `derive` produces text and structure for the
  index. Only stage one writes to the vault.
- **Archive reader.** Zip with zip64, entries opened as streams through the central
  directory, multi-part archives presented as one tree. The archive is never unpacked to
  disk. One vetted zip dependency is acceptable here; it is recorded in `DEPENDENCIES.md`.
- **Mail.** The mbox is split on message boundaries into individual messages while
  streaming. Memory stays flat regardless of mbox size. The separator line is kept in the
  event so the original file can be reproduced byte for byte.
- **Location history.** The predecessor's parser covers the older Takeout formats
  (`Records.json`, Semantic Location History). Newer accounts keep Timeline on the phone
  and export a different file from device settings. The location importer must handle
  both and is not part of the thin slice.
- Fixtures are generated by scripts in the repository. No fixture is copied from a real account.

## 8. Second copy

### 8.1 Mode B vault session

```
1. Detect the drive, read its VAULT.json. Refuse if vault_id differs or the
   file system has a 4 GiB file limit.
2. Verify the drive: every manifest and signature, every file hash, the whole
   chain.                                                                (no secret needed)
3. Compare the drive's chain head with the head recorded on the working device
   for this copy. Older than recorded, or a different hash at the same segment
   number: STOP and show a rollback or tamper warning.
4. Close the open segment on the working device.
5. Copy each missing segment: files first, manifest last, fsync.
6. Re-read and re-hash what was copied.
7. Mark the new segments read-only. Write keyring (if the medium is rewritable) and HEAD.json.
8. Record the new head for this copy on the working device. Append `copy.sealed`.
9. Show the anchor as text and QR for printing: vault id, epoch, segment number,
   manifest hash, public-key fingerprint. Tell the user to switch on write
   protection and disconnect.
```

- The session is the only time the drive is writable. With a write-protect switch the user
  flips it off at step 1 and on at step 9; the product checks at step 2 whether the drive
  is writable and says which state it expected.
- Any failure leaves the drive's previous segments untouched, reports loudly, and the
  session can be re-run. A partly copied segment has no manifest and is removed at the next session.
- Cadence (**Decided**): weekly default; daily, monthly, manual. Banner after 14 days.
- Optical export: `foundry vault export-iso` writes closed segments and manifests (no
  keyring by default) to an image for BD-R or M-DISC. The disc must be written as a
  single, finalised session: on a multi-session disc a later session can hide earlier files.
- Media facts the wizard states:
  1. The lock tab on an SD card is only a request to the card reader. It is not write
     protection. A USB drive whose switch is enforced by the drive's own controller, or a
     hardware write-blocker, is.
  2. Flash memory left unpowered for years can lose data. The scheduled verification
     exists to catch that while the other copy is still good.
  3. A keyring kept off a write-once disc means the disc alone cannot restore anything.
     It needs a keyring from another copy.

### 8.2 What the chain proves

A drive that simply lacks the newest segments is internally consistent. Rollback,
truncation at the end and whole-drive replacement are detectable **only** by comparing
against a chain head held somewhere else: the working device, the other copy, or the
printed code. The product stores the head in all three places and checks at every
session. The docs say "tamper-evident", never "tamper-proof" or "undeniable".

Two limits no design removes: an anchor that is itself out of date cannot reveal the loss
of segments written after it, and an exact copy of a drive is indistinguishable from the
original. A damaged copy is repaired from the other copy, which is why there are two.

### 8.3 Restore drill

The drill reads the second copy read-only, checks it against the anchor, verifies
manifests, signatures and file hashes, authenticates every record, replays withdrawals,
and builds a throwaway encrypted index. Nothing is published until all of that succeeds.
Decrypted content is held in memory or in the encrypted index only; the drill never
writes plaintext to a temp directory.
The drill's test suite must include: missing last segment, two segments swapped, one
flipped bit, a drive from a different vault, a copy older than the newest withdrawal, and
a drill interrupted halfway.

### 8.4 Mode A (later phase)

- Receiver is not a service. It is a command the sender starts over SSH, restricted by a
  forced command in `authorized_keys`, which accepts new segment files, verifies chain
  continuity, refuses any overwrite or delete, and exits. Memory ceiling 96 MiB.
- The pairing credential can do nothing except run that command.
- When the device is unreachable, the sender queues and shows a flag. It never drops data silently.
- First supported receiver OS: Linux. A Windows receiver depends on a spike.
- A1 (home network) uses a pinned host key. A2 (remote) requires a private overlay
  network; the wizard will not configure port-forwarding.

## 9. Resource budgets

Proposed ceilings for peak resident memory. Each is asserted in CI on Windows and Linux
from the process's own peak-usage counter. A ceiling may be raised only by a recorded decision.

| Command | Ceiling | Note |
|---|---|---|
| Facts ledger, any subcommand | 96 MiB | Step Zero |
| `vault verify` (no key) | 128 MiB | Streaming hashes |
| Any command that runs the passphrase KDF | 256 MiB | scrypt needs about 128 MiB for under two seconds |
| `import` | 256 MiB | Independent of archive size |
| `search` | 192 MiB | Full text; vectors scanned in batches |
| Wizard server | 192 MiB | Exits when the wizard closes |
| Mode A receiver | 96 MiB | |

How it is measured: the operating system's own peak counter for the process (peak working
set on Windows, peak resident set on Linux), read at exit, using the pinned runtime binary
that ships. Helper processes a command starts (for example `git`) are measured too and
count against a separate process-tree ceiling of twice the command's own. The ceilings are
proposals until the first measurement work package in each phase confirms them; if a
measured floor makes a ceiling impossible, the ceiling is changed by a recorded decision
before code is written against it.

Other rules: one heavy job at a time (a lock file, not a queue service); every command has
a wall-clock limit; no command starts a process that outlives it, except a model server
that exits after an idle timeout.

## 10. Threat model

| Threat | Covered? | How |
|---|---|---|
| Lost or stolen second-copy drive | Yes | All content encrypted; manifest reveals sizes and dates only |
| Stolen working device, powered off | Yes, if no `os-protected` key cache | Vault and index encrypted at rest |
| Malware running as the user while unlocked | No | It can read what the user can read. Stated plainly. |
| Ransomware or a bug rewriting the working copy | Detected and recoverable | Hash chain plus an offline sealed copy it could not reach |
| Silent edit of history on a sealed copy | Detected | Chain and manifests |
| Swap of a sealed drive for an older state | Detected if an independent chain head exists | Section 8.2 |
| Administrator on the same machine bypassing read-only flags | Not prevented by software | Hardware write-protect or write-once media |
| Drive failure, fire, loss | Not prevented | Two copies in two places, scheduled verify, restore drill |
| Forgotten passphrase | Recoverable with the recovery key only | Section 5.3 |
| A person asks for their data to be removed | Yes, with the limits in 5.7 | Key destruction |
| Supply-chain compromise of a dependency | Reduced | Minimal dependencies, pinned versions, hash-verified releases |

Network exposure in v1 is zero listening ports except the loopback wizard, which binds
`127.0.0.1` on a random port and requires a one-time token in the URL.

## 11. Relationship map and stable layout

- Nodes are people, places, topics and items. A node's id is random and is recorded in the
  vault by a `node.created` event the first time its kind and canonical key are seen. A
  rebuild replays those events, so the same entity keeps the same id. An id computed from
  the name would change, and lose its position, whenever name normalisation improved; with
  recorded ids a deriver upgrade that changes a key records a `node.merged` instead.
- Every ordering that affects ids or positions is by raw bytes with an explicit sort.
  Locale-aware comparison differs between machines.
- An edge exists only with an `evidence_event_seq`. Edges proposed by a model are stored
  with `inferred = 1` and a confidence, and are drawn differently. The map must not invent relationships.
- **Positions are recorded, not recomputed.** Re-running a force simulation gives
  different coordinates across runs and library versions. Instead:
  1. When a node first appears, a placement function chooses integer grid coordinates:
     near the integer median of its already-placed neighbours, spiralling outward to the
     first free cell, starting from a cell chosen by the node id hash when it has no
     neighbours. Integer arithmetic only.
  2. The function is fully specified so two machines agree: neighbours are taken in node-id
     order and capped at 32; the spiral order is fixed; the search stops after 4,096 cells
     and falls back to a fixed overflow row. The caps keep a node with thousands of
     neighbours from making an import slow. Only edges backed by stored records count as
     neighbours. Model-inferred edges never influence placement, because model output
     differs between machines.
  3. A large first import has no placed neighbours to start from, and placing nodes one by
     one would turn import order into geography. So nodes created by one import are placed
     together at the end of that import: grouped into regions by kind and source, then
     placed inside the region. Every placement event names the algorithm and its version.
  4. The result is appended to the vault as a `layout.placed` event and projected into
     `graph_positions`. A node is not shown until its placement is recorded.
  5. Rebuilding the index replays those events. The picture is the same on every device
     and after every rebuild.
  6. A user who wants a fresh arrangement triggers `layout.epoch`, which starts a new set
     of placements. Old epochs remain in history.
- Dragging a node appends one `layout.moved` when the drag ends. Merging two nodes appends
  `node.merged`, which names the survivor and maps the retired id to it. The survivor
  keeps a position the user chose by dragging, otherwise the earlier placement. The
  retired node's placement stays in history so undoing the merge restores it. Edges keep
  their evidence.
- Removing evidence removes the edges that depended on it and never moves the nodes that remain.
- A force simulation may be offered as an explicit "rearrange" action. Its result is
  committed as a new epoch of recorded positions; it is never the source of truth.
- The renderer may animate, but it starts from and returns to stored positions.
- Geographic coordinates (`places`) and map-layout coordinates are separate and never mixed.

## 12. Local models

- Models are optional and never required for Tier 0.
- Runtime: a permissively licensed local inference server, started on demand by the
  command that needs it and stopped by an idle timeout. Never resident.
- A model catalog file lists, for each model: download URL, SHA-256, license, file size,
  measured peak memory, and the tier it needs. The default catalog contains only models
  under MIT or Apache-2.0 terms. Downloads are started by the user and hash-verified.
- Candidates are chosen by benchmark on a Tier 1 reference machine during the models work
  package, not named in this document.
- One inference at a time.

## 13. Packaging

- v1 ships a directory bundle: the official, unmodified Node runtime binary, the bundled
  JavaScript, and the native SQLCipher addon for that platform. Single-file executables
  are avoided for three reasons: a native addon cannot be loaded from inside one without
  unpacking to disk, injecting an application into the runtime binary invalidates the
  runtime's own signature, and a program that unpacks a binary to a temp folder and loads
  it looks like malware to antivirus tools.
- A second channel for technical users: an npm package that runs on a Node 24 the user
  already has. Same code, same addon builds.
- The native addon is built per runtime major version, per platform. The project builds
  and publishes its own addon binaries in CI and does not depend on upstream release timing.
- Free integrity measures are used from the first release: build provenance attestations
  for release assets and npm provenance for the package.
- Windows: zip plus `install.ps1` that verifies SHA-256 and installs per-user; a WinGet
  manifest pointing at the release asset. No MSIX in v1, because MSIX requires a signed package.
- Linux: tarball plus `install.sh` into the user's home; `.deb` later. glibc-based
  distributions only in v1. The installer checks the platform, architecture and C library
  and stops with a clear message on anything untested.
- Each release names the exact runtime version and native-addon build it was tested with.
  Every advertised platform is tested on a clean machine image before release.
- Windows may warn about, or under some policies block, an unsigned download. A checksum
  proves the file is intact; it does not make Windows trust the publisher. On machines
  with Smart App Control switched on, the unsigned native addon may be refused outright;
  this must be tested on a clean Windows 11 image before the first release. If it is
  refused, the user's choices are the `plain` driver with disk encryption (section 5.5,
  explicit opt-in) or waiting for a signed build. See risk R-1 in [DECISIONS.md](DECISIONS.md).
- Windows on arm64 is not supported in v1.
- Schedulers: a per-user Task Scheduler entry on Windows, `systemd --user` timers on Linux,
  with a cron fallback.
- Releases are built in CI, with checksums published next to the assets.

## 14. Relationship to the private predecessor

Foundry is a clean extraction, not a fork. Components are re-homed file by file through a
scrub gate; no git history is carried. The record format here is deliberately not
byte-compatible with the predecessor's blob format: it adds a key id for erasure, binds
records to a vault, and uses new derivation labels. The predecessor adopts Foundry later
as a consumer, with a one-time migration that is planned separately and is not public.

## 15. Test gates that protect the architecture

| Gate | Fails the build when |
|---|---|
| Format vectors | TypeScript writer and Python reader disagree on any vector |
| Tamper suite | A flipped bit, removed file, reordered record, swapped manifest or replayed record passes verification |
| Crash suite | A write killed at any point leaves a vault that cannot be opened or repaired automatically |
| Offline run | Import and search produce any network packet |
| Memory | Any command exceeds its ceiling in section 9 |
| Erasure | Data under a destroyed key is readable through any command, or remains in the index |
| Rebuild | Index after `rebuild` differs from the incrementally built index |
| Layout | Two rebuilds give different node positions |
| Withdrawal on restore | Restoring any older copy makes a withdrawn item searchable, or a redacted item can be re-imported |
| Restore drill | Any failure case in section 8.3 passes the drill |
| Fail closed | The index opens unencrypted without the explicit `plain` choice |
| Index at rest | A planted marker string is found in the index file, its write-ahead log, a journal or a spill file |
| Identifier scan | A personal name, hostname, home path, token or key appears in the tree **or in a release archive** |
