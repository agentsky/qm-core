# Deployment

`deploy/<service>/Dockerfile` builds the service images the Helm chart runs: `core` and
`egress-proxy`. The release workflow
[`.github/workflows/release-package.yml`](../.github/workflows/release-package.yml) builds
and cosign-signs each one into `ghcr.io/yc-software/qm`;
[`scripts/deploy-helm.sh`](../scripts/deploy-helm.sh) builds and pushes the same set to
your own registry and then installs the chart.

[`sandbox-base/`](./sandbox-base/) and [`sandbox-local/`](./sandbox-local/) build the agent
computer images: the shared base toolset, and the local Docker sandbox stacked on top of
it for `SANDBOX_BACKEND=local`. See [`sandbox-base/README.md`](./sandbox-base/README.md).

[`helm/`](./helm/) is the chart itself. [`docs/getting-started.md`](../docs/getting-started.md)
covers the prerequisites and the values you must set.

## Upgrading from a values file that names browser services

`services.web-ui`, `services.admin`, `services.portal`, and `services.auth` no longer
exist: the deployment is `core` (Slack plus the HTTP API) and `egress-proxy`. Remove
those blocks from your values overlay before upgrading. The chart renders a Deployment
for every enabled entry under `services`, so a leftover block would ask the cluster for
an image that is no longer built; an `ingress.service` naming one fails the render.

## Upgrading to chart 0.5

Core now claims a `ReadWriteOnce` persistent volume for its data directory
(`services.core.persistence`, default 10Gi from the cluster's default StorageClass) and
rolls out with the `Recreate` strategy, because uploaded files, blob transfers,
workspaces, and deployment checkouts live as bytes under that directory rather than in
Postgres. Bytes written by an earlier release sat on the container filesystem and are
already gone with that pod; nothing migrates. The claim is annotated
`helm.sh/resource-policy: keep`, so `helm uninstall` leaves it and its bytes in place.
Core also runs with `SESSION_STORE=postgres`, `RUN_STORE=postgres`, and `HARNESS=pi`
unless your overlay sets them (at either `env` or `services.core.env`), and the render
fails for more than one core replica while persistence is on, since one `ReadWriteOnce`
volume cannot follow two pods.

Nothing here is a production deployment, and none of it contains cloud account,
workspace, or organization credentials. The one exception is [`layers/`](./layers/), which
is empty in qm itself: a private fork keeps its organization's values file and deployment
material there, and that material never travels back upstream.

## Topology

The ingress points at `core`, which serves the HTTP API: Slack events and
interactions, webhooks, and published apps. Postgres and agent computers stay
private. The Slack surface runs inside core, over outbound Socket Mode when you do
not route Slack over HTTP.

The chart ships no identity provider. Core establishes who a browser-borne caller is
from a signed `x-portal-identity` header, verified with `PORTAL_IDENTITY_SECRET`;
something in front of core has to authenticate the user and mint that header. Until
you put one there, core has no way to sign anyone in.

Core receives `RESEND_API_KEY` and `AUTH_EMAIL_FROM`, which let admins email
invitations to external users over the admin API or by chatting with QM; both are
optional, and without them the invitation is still created and the sign-in link is
shared by hand.

Connector OAuth clients and the optional Slack bot token pair are set through core's
authenticated admin API. Secrets are encrypted in durable storage and are never
committed to a values file. The agent advertises only connectors whose admin
configuration is enabled.
