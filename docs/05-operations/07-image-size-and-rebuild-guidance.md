# Image size and rebuild disk use: Dockerfile guidance

**Status:** written guidance, not yet applied. No Dockerfile has changed and nothing here has been built or measured. See [ADR-037](../00-foundation/adr/ADR-037-hardening-backlog.md) D1 and D7. The only measured sizes are from the M1 report: 720 MB for the worker image and 361 MB for web, on one machine, at M1. Measure again before and after each step, and record the result, because the savings below are not estimated.

Apply one step at a time. After each, run the stack tests, because a removal that breaks startup shows only when the image runs.

## Why the worker image is bigger

`workers/workflow/scripts/build.mjs` already prebundles the workflow code, so production never runs a bundler. The packages are still there, because `@temporalio/worker` lists them as dependencies and `pnpm deploy --prod` copies them. In `@temporalio/worker` 1.25.0:

| Package | Used at runtime? | Can it go? |
|---|---|---|
| `@swc/core` and its native package | Only by `swc-loader`, while bundling | Candidate. Nothing outside the bundler loads it |
| `webpack` | `lib/workflow/bundler.js` requires it at load, and `lib/worker.js` requires that file | **No, not by deleting it.** The worker would fail on import |
| `swc-loader`, `source-map-loader`, `memfs`, `unionfs` | Only while bundling, by what the code reads | Candidates, but check each, because `bundler.js` may require them at load as it does webpack |

## Reducing the worker image

Each goes in `infrastructure/containers/Dockerfile.worker`, in the build stage, after `pnpm deploy` and before anything copies `/out`.

1. **Remove the native compiler,** the same way `Dockerfile.web` removes the image library:

   ```dockerfile
   RUN find /out/node_modules/.pnpm -maxdepth 1 -type d -name '@swc+core*' -prune -exec rm -rf {} +
   ```

   Then look for a dangling link in `/out/node_modules`, and confirm the worker starts and finishes a workflow. `tests/stack/workflow-behaviour.test.ts` covers that.

2. **Do not delete `webpack`.** If it has to go, the safe route is to bundle `@temporalio/worker` with esbuild and replace its `./workflow/bundler` import with a stub. That is a code change with a native module in the path, and an SDK upgrade can break it, so it needs its own ADR and a measured reason.

3. **Keep `better-auth` and the web tier's packages out.** Check what `pnpm --filter @ensemus/worker deploy --prod` really copies, with `du -sh /out/node_modules/.pnpm/* | sort -h`, and look at the largest. `@ensemus/*` are dev dependencies of the worker, because esbuild bundles them, so nothing from them should appear there.

4. **After any removal, repeat the license check on what ships.** The SBOM from `build-release.mjs` lists it.

## Reducing what each rebuild adds to disk

Today both Dockerfiles run `COPY . .` before `pnpm install`. **Any change to any source file throws away the install layer,** so each rebuild writes the whole dependency tree again, and the old layers stay on disk until someone removes them. This is the main cause of the growth.

1. **Copy only the manifests before installing,** so a source change leaves the install layer alone. Every workspace `package.json` has to be listed, including new ones, or the install fails, which is at least loud:

   ```dockerfile
   COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.cjs ./
   # ...each apps/*, packages/* and workers/* package.json the image's filter needs...
   RUN pnpm install --frozen-lockfile --filter "@ensemus/worker..."
   COPY . .
   ```

   `pnpm fetch` is an alternative to listing them, since it needs only the lockfile. It installs from a store, so it also needs a `pnpm install --offline` afterwards.

2. **Use a BuildKit cache mount for the pnpm store,** so a change to the lockfile downloads only what changed. It stays out of the image, and it needs no network on a repeat build:

   ```dockerfile
   RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm config set store-dir /pnpm/store && \
       pnpm install --frozen-lockfile --filter "@ensemus/worker..."
   ```

3. **Narrow what the build context sends.** `.dockerignore` already leaves out `docs`, `tests` and `.claude`. Add `**/*.test.ts`, `**/*.test.tsx` and `*.md`, so that changing a test or a note does not invalidate a later layer.

4. **See what is using the disk before removing anything:** `docker system df -v` and `docker buildx du`. Removing images and build cache is the operator's decision, and nothing in this repository does it for you. `run-all-gates.sh` and the gates never prune.

## Making the images reproducible

`reproducible-gate.mjs` reports the difference between two builds. Each of these removes a cause it is expected to find. Once it reports no difference, drop `--report-only` from `ci.yml` and `run-all-gates.sh` (ADR-037 D1).

1. **The Server Action key in the web image.** The Next.js build writes a random key to `server-reference-manifest.json` when it finds none, and that alone makes every web build different. `apps/web/start.mjs` refuses to start without a per-deployment key, which overrides it, so the embedded one is never used (ADR-025 D7). The proposal is a fixed, public, all-zero key for the build stage only:

   ```dockerfile
   # Not a secret, and never used: start.mjs refuses to start without a per-deployment key.
   ENV NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
   ```

   **This one needs the security owner's agreement before it is applied,** because it touches what ADR-025 D7 reviewed, and the runtime stage must not inherit it. Confirm `start.mjs` still refuses to start without its own key, and that `tests/stack` covers that, in the same change.

2. **Timestamps.** The gate passes `SOURCE_DATE_EPOCH` and `rewrite-timestamp=true`, so layer timestamps need no Dockerfile change. A file whose content records the time will still differ, and the gate's report names it.

3. **The build tools.** `package.json` now pins pnpm by hash and `.nvmrc` names the exact Node version the base image holds. Keep the base image digest and `.nvmrc` moving together.
