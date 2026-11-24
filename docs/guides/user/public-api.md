---
title: The public API
audience: user
area: work
tickets: [API-12]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [docs/specifications/openapi.yaml, apps/web/src/server/api.ts, apps/web/src/app/api/v1/organizations/[organizationId]/work-units/route.ts, apps/web/src/app/api/v1/organizations/[organizationId]/work-units/[workUnitId]/route.ts, apps/web/src/app/api/v1/organizations/[organizationId]/work-units/[workUnitId]/dependencies/route.ts, apps/web/src/app/api/v1/organizations/[organizationId]/work-units/[workUnitId]/events/route.ts, apps/web/src/app/api/v1/organizations/[organizationId]/approvals/route.ts, apps/web/src/app/api/v1/organizations/[organizationId]/approvals/[approvalId]/route.ts, apps/web/src/app/api/v1/organizations/[organizationId]/approvals/[approvalId]/decisions/route.ts, packages/application/src/errors.ts, packages/application/src/idempotency.ts, packages/application/src/work.ts, packages/application/src/approvals.ts, tests/stack/api.test.ts]
tests: []
---

# The public API

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

The API reads and changes work and approvals with the same rules as the pages. Every path below starts with `/api/v1`, on your deployment's own address. The examples use `https://localhost:8443` in its place.

| What | Method and path |
|---|---|
| List work you can see | `GET /organizations/{organization_id}/work-units` |
| Create work | `POST /organizations/{organization_id}/work-units` |
| Read one piece of work | `GET /organizations/{organization_id}/work-units/{work_unit_id}` |
| Change its title, objective or due date | `PATCH /organizations/{organization_id}/work-units/{work_unit_id}` |
| Follow it live | `GET /organizations/{organization_id}/work-units/{work_unit_id}/events` |
| Add something it depends on | `POST /organizations/{organization_id}/work-units/{work_unit_id}/dependencies` |
| List approvals waiting for you | `GET /organizations/{organization_id}/approvals` |
| Read one approval | `GET /organizations/{organization_id}/approvals/{approval_id}` |
| Decide one | `POST /organizations/{organization_id}/approvals/{approval_id}/decisions` |

## How you sign in

**API keys and tokens are not available yet.** The API accepts the session you get by signing in to Ensemus. On a deployment served over https, that is the cookie named `__Secure-better-auth.session_token`.

A session belongs to one person, so a call can do what that person can do. It stops working when they sign out or when the session ends, and when they are disabled it answers as for anything they cannot see.

A token in an `Authorization` header is refused with 401. A change, which is anything but a read, also has to carry an `Origin` header naming your deployment. So today this suits code running in a page on the deployment itself.

## Create work

A create needs an `Idempotency-Key` of 8 to 128 characters. Send the same key and the same request again, and you get the first answer back with nothing done twice. A failed request stores nothing, so it can be repeated.

```bash
curl -X POST "https://localhost:8443/api/v1/organizations/$ORG/work-units" \
  -H "Cookie: __Secure-better-auth.session_token=$SESSION" \
  -H "Origin: https://localhost:8443" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"title":"The report is sent","objective":"Written for the quarter","completion_criteria":{"artifact_exists":true}}'
```

`title`, up to 300 characters, and `objective`, up to 10,000, are required. `project_id` and `due_at` are optional. `completion_criteria` is optional, and takes `artifact_exists` and `reviewer_approved`. Work created this way is **Internal**, with you as its accountable owner.

The answer is 201, with the work and an `ETag` header holding its version.

## Read work

A list gives `items` and `next_cursor`, up to 50 at a time. Pass `next_cursor` back as `?cursor=` for the next page. It is `null` when there are no more. Filter with `?status=`.

| `status` | On screen |
|---|---|
| `queued` | Waiting to start |
| `ready` | Ready |
| `running` | In progress |
| `blocked` | Blocked |
| `awaiting_approval` | Waiting for approval |
| `verifying` | Checking |
| `completed` | Done |
| `failed` | Failed |
| `cancelled` | Stopped |

Reading one piece of finished work also gives `completion`. Its `basis` is `evidence`, `owner_confirmed` or `not_recorded`.

## Change work

Send the version you last read in `If-Match`.

```bash
curl -X PATCH "https://localhost:8443/api/v1/organizations/$ORG/work-units/$WORK" \
  -H "Cookie: __Secure-better-auth.session_token=$SESSION" \
  -H "Origin: https://localhost:8443" \
  -H "Content-Type: application/json" \
  -H 'If-Match: "3"' \
  -d '{"due_at":null}'
```

Send at least one of `title`, `objective` and `due_at`. If someone changed it first, you get 409 `VERSION_CONFLICT`, and the later change stands. Read it again, then decide. You cannot change work that is paused or finished.

## Add a dependency

Send `{ "prerequisite_id": "..." }`. The answer is 201 with no body, and adding the same one again is not an error. See [Dependencies between work](dependencies.md).

## Decide an approval

Read the approval first, and look at `action`, which is exactly what you are deciding. Send its `action_hash` back with your decision.

```json
{ "decision": "deny", "action_hash": "<the action_hash you read>", "reason": "The figures are from last year" }
```

`reason` can be up to 2,000 characters. It is required to deny an approval the work is paused on, because that stops the work for good. The answer is 200 with no body. See [Approvals](approvals.md).

## Follow work live

`GET .../events` is a stream of server-sent events. An event named `status` carries the current version, as both its data and its ID. Between them there are comments, to keep the connection open. With `?include=evidence` you also get an event named `evidence` when its files or reviews change. Its data is only a value to compare, and says nothing about them.

Connections close after about 15 minutes, and a browser's `EventSource` reconnects by itself and sends `Last-Event-ID`, so you resume from there. The stream ends when access is lost or the session ends. See [Live status and reconnecting](live-status.md).

## What it will not do

- It has no way to change a status, stop work or reopen it, attach or delete files, or remove a dependency. Use the work's page.
- It has no way to set a work's sensitivity or a plan, or to manage people, teams, clients, projects or the inbox.
- Anything not in the table at the top of this page is not available through this API.

## When it refuses

Every refusal has the same shape. Messages are fixed text and never repeat what you sent. `details.fields` names fields, never their values. Quote `request_id` to your administrator, and it is also in the `X-Request-Id` header.

```json
{
  "code": "VERSION_CONFLICT",
  "message": "Someone else changed this first. Reload to see the latest version.",
  "request_id": "00000000-0000-4000-8000-000000000000",
  "retryable": false
}
```

| Status | `code` | What it means |
|---|---|---|
| 400 | `INVALID_INPUT` | Malformed path, query, header or body, or a missing or short `Idempotency-Key` |
| 400 | `REASON_REQUIRED` | Denying paused work needs a reason |
| 401 | `UNAUTHENTICATED` | No valid session |
| 403 | `ORIGIN_NOT_ALLOWED` | A change did not name your deployment in `Origin` |
| 403 | `FORBIDDEN` | You can see it, and may not change it |
| 403 | `APPROVAL_WRONG_APPROVER`, `APPROVAL_SELF_APPROVAL` | You are not the person who can decide this |
| 404 | `NOT_FOUND` | It does not exist, or you may not see it. The answer is the same |
| 409 | `VERSION_CONFLICT` | Someone changed it first |
| 409 | `IDEMPOTENCY_KEY_REUSED` | This key was used with a different request. Nothing was done |
| 409 | `DEPENDENCY_CYCLE` | This would make a loop |
| 409 | `INVALID_STATE` | Not while the work is in this status |
| 409 | `APPROVAL_NOT_PENDING`, `APPROVAL_EXPIRED`, `APPROVAL_HASH_MISMATCH`, `APPROVAL_STALE` | This approval can no longer be decided as you asked. Read it again |
| 413 | `PAYLOAD_TOO_LARGE` | The body is over 256 KB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Send `application/json` |
| 428 | `PRECONDITION_REQUIRED` | `If-Match` is missing |
| 500 | `INTERNAL_ERROR` | Something failed on our side. Do not assume repeating it is safe |
| 503 | `RESTORE_PENDING` | The organization is being restored. Nothing was done, and this is the only code with `retryable` set to `true` |

## What another organization can see

Nothing. Asking for another organization, or for its work or approvals, answers 404 `NOT_FOUND`, the same as for something that does not exist, and changes nothing. Keys for `Idempotency-Key` belong to one person in one organization, so two people can use the same key. Restricted work you are not on answers the same 404, and it does not appear in a list.
