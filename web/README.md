# Web UI

A React + Vite single-page app over the HTTP API. Sign in with Cognito, start a run, and follow
it:

- **Start form**: one to five images (JPEG, PNG or WebP), untagged: sketches or photos of the
  product and, optionally, a sample of its material. There is no role picker; the analyser decides
  what each image is. **Product details (optional)**: plain text or JSON, typed or loaded from a
  `.txt` or `.json` file; the form says which it was read as. Or start a sample product, whose
  sketch and material sample are submitted the same way.
- **Inputs**: on the upload and analyse cards and in the inputs panel, each thumbnail is labelled
  with what the analyser read it as (Sketch, Photo, Material sample, Not used), its few words on
  the image in the tooltip (`src/lib/inputs.ts`).

- **Stage canvas** (`@xyflow/react`): each stage as a node, retries as edges, with a scrubber to
  replay the run. The canvas takes the screen height left under the top bar and fits the graph to
  that height on load and resize; when the graph is then wider than the pane, the camera follows
  the stage at work (the fit button shows the whole graph).
- **Generation progress**: the `generate_2d` card and its detail show the four views of the
  current attempt (waiting, generating with elapsed time, done, failed, or kept from an earlier
  attempt) under "Attempt n of N" or "Regeneration n". Under the scrubber, a live line names
  everything in progress, e.g. "Generating left and right (attempt 1 of 2)". Derived from the
  events and candidates in `src/lib/progress.ts`.
- **Notifications**: when a watched run reaches review, approval or failure, a toast appears and,
  while the tab is not in view, the tab title is prefixed ("● Ready for review — …") until it is
  and a system notification is sent if allowed. Permission is asked only from a click: starting a
  run or **Notify me** in the top bar. A run already finished when the page loads does not notify.
  Logic in `src/lib/notify.ts`.
- **Stage detail**: each stage's input and output, and the model it called.
- **Candidates and verdicts**: the specification (product type, material, colour, dimensions,
  parts drawn, marks left out), the generated views, the critic's verdict and issues per view,
  each mismatch with the critic's reason (parts grouped).
- **Prompt panel**: the prompt of each view and attempt, with a diff between attempts.
- **Review gate**: approve, or regenerate with notes.

## Configuration

Read at build time from Vite environment variables. `deploy.sh` sets them from the Terraform
outputs.

| Variable | Value |
| --- | --- |
| `VITE_API_URL` | Empty when deployed (same-origin `/api/*` through CloudFront and AWS WAF); the site origin, output `web_url`, for local dev |
| `VITE_COGNITO_URL` | Cognito hosted UI origin, output `hosted_ui_url` |
| `VITE_COGNITO_CLIENT_ID` | Web app client ID, output `user_pool_client_id` |

Without the two Cognito variables, sign-in is disabled and requests carry no token, so the
deployed API rejects them.

## Run locally against a deployed API

```sh
VITE_API_URL=<web_url> VITE_COGNITO_URL=... VITE_COGNITO_CLIENT_ID=... npm run web:dev
```

`VITE_API_URL` is the CloudFront site (output `web_url`), not the `execute-api` endpoint, which
refuses requests that did not come through CloudFront. The dev server listens on
`http://127.0.0.1:5273`. The default `allowed_web_origins` registers that origin for API CORS,
upload CORS and the Cognito callback.

## Build and test

```sh
npm run web:build              # output in web/dist
npm test -w @sketch-to-product-views/web      # layout, camera, views, progress, notification, replay and sign-in tests
```

## Hosting

`infra/modules/web`: a private S3 bucket behind CloudFront with Origin Access Control, a
response headers policy (Content Security Policy and other security headers) and AWS WAF. The
same distribution serves the API under `/api/*`.
`deploy.sh` uploads `web/dist` (hashed assets cached as immutable, `index.html` revalidated)
and invalidates the distribution.
