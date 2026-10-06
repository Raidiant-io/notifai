# Native runtime distribution materials

`release-materials.json` binds the exact notice and source-information files
packaged with each target. The same conservative notice superset is carried on
all six targets. It includes optional and build dependencies; inclusion is not
a claim that every listed component is linked on every platform.

The review is tied to Bun 1.4.2, commit
`744846f844374847c902b5e7fd59b4342a51ef99`, and its WebKit commit
`2e2aa2290fac856d6f451ceacb58f7f5b44dd057`. It covers the upstream license index,
native dependency notices, all 181 registry entries in Bun's Cargo.lock, all
103 package references in its node-fallback lockfile, and Notifai's production
npm dependencies. Registry source archives were checked against their lockfile
integrities before extracting notices. README-embedded grants and missing
package notices were resolved against upstream source and are included.

`NOTICE-PROVENANCE.json` retains the collection records, including their
original research-stage observations. Supplemental records resolve those
observations. `SOURCE-NOTICES.txt` preserves distinct license/copyright comments
from Bun and WebKit source. The complete source archives retain all original
files, including notices that are not extracted into that summary.

Bun declares its own code MIT-licensed but supplies no single project-wide
copyright line or standalone MIT grant. Its declaration, standard MIT terms,
and actual per-file notices are preserved; no copyright owner is invented.
Bun does not pin the uucode revision from which its credited algorithm was
ported, so the matching upstream v0.2.0 notice is conservatively included.
The pinned WebKit source establishes ICU 78.3 and simdutf 9.0.0. The index's
libbase64 attribution is also included conservatively.

The LGPL-2.0 and LGPL-2.1 texts that govern JavaScriptCore, WTF and TinyCC are
included in full. No component is distributed under the plain GPL, so no GPL
text is bundled: the source notices that name it are a libgcc-derived file
with an unrestricted linking exception, Bison-generated parsers under the
Bison exception, and MPL/GPL/LGPL tri-licensed files used under the MPL. This
is an engineering review of the upstream notices, not a legal opinion.

## Corresponding source

`runtime-sources.json` identifies the first-party immutable source release,
including the exact Bun, patched WebKit and TinyCC archives and the four
MPL-2.0 crate source archives. The same manifest ships in every runtime archive
as `CORRESPONDING-SOURCES.json`. Notifai's own complete source, lockfile, build
scripts and license are available at the exact native release tag.

Source assets must be uploaded and their size and SHA-256 verified before the
source release is published. Finalization verifies that the public source
release is immutable and that every uploaded asset matches this manifest.
Keep those source assets available for every distributed runtime using them.
Never overwrite them when changing a runtime; use a new source release and
reviewed manifest.

The source release is supporting material, not an installable CLI or an update
channel. See the bundled `REBUILDING.md` for the source and relinking path.

## Updating the materials

For a runtime or dependency change, collect full upstream notices from the
exact source/lock identities, resolve missing grants from their upstream
source, and preserve the actual copyright statements. Refresh the source
archives and provenance, review the result, then regenerate each target's
file size and SHA-256 entries. `prepare-reviewed-materials.mjs` rejects any
byte mismatch. Candidate markers and placeholder notices cannot be approved.

The macOS Team ID in the policy is public publisher verification data. Signing
private keys and notary credentials are held in the protected release
environment and are never part of these materials.
