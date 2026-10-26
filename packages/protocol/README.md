# `@raidiant/notifai-protocol`

The public wire contract used by the Notifai CLI and service. It provides
TypeBox schemas and TypeScript types for notification drafts, ordered media
collections, structured source context, REST v1 requests and responses,
status vocabulary, lifecycle hints, and platform capabilities.

```ts
import { CAPABILITIES_V1, validateDraft } from '@raidiant/notifai-protocol'
```

The package has no service implementation or private configuration. Node-only
helpers are available from `@raidiant/notifai-protocol/node`.

Presentation content has two separate roles: `summary` is required one-line
plain text (maximum 240 Unicode code points) for banners and list surfaces;
`body` is optional non-empty Markdown for focused detail. Push envelopes carry
the full Body when the whole payload fits the provider's size limit, and
otherwise `has_body` tells the app to fetch it. They never carry a derived or
truncated Body excerpt.

Licensed under Apache-2.0. See the repository-level `LICENSE` and `NOTICE`.
