# Workspace suites: first live run

The connectors and agent tools in [ADR-038](../00-foundation/adr/ADR-038-workspace-suites.md) were built against local fakes. This run checks them against real Google and Microsoft services, using **test tenants that hold only made-up data**. The owner approved this on 2026-11-11. It is not the outside security review, and it does not replace it. Never connect a real company account or real customer data.

**Who does what.** You create the test tenants, register the apps, and sign in on Google's and Microsoft's own pages. Nobody else should handle those passwords or client secrets. Everything on the Ensemus side is scripted below.

## What this run settles

| Question | How it is answered |
|---|---|
| Does connect by consent work end to end, for the organization and for a member? | Parts D and E |
| Are the granted scopes recorded as the provider reports them? | The connection page after connecting |
| Does a file shared with a group reach that group's members here, and stop when someone leaves the group? | Part E, directory steps |
| Does Google's Directory API answer on `www.googleapis.com`, or only on `admin.googleapis.com`? | `--directory` live check |
| Do Gmail and Exchange keep our Message-ID, so a send can be found again? | `--send-to-self` live check |
| Does a repeated calendar create stay one event? | `--writes` live check |
| Does Microsoft need an explicit admin-consent prompt? | Part B, step 6, and Part D |

## Part A: Google test tenant and app

1. **Tenant.** Use a Google Workspace trial on a domain you own and use for nothing else. Gmail personal accounts cannot test the directory.
2. **People and data.** In the Admin console, create two users, `test-admin` (super admin) and `test-member`. Create a group, `finance-test`, with `test-member` in it. As `test-admin`, create a Doc, a Sheet and a plain text file in Drive, and share the text file with `finance-test` only.
3. **Project.** In Google Cloud console, create a project inside the test organization. Enable: Google Drive API, Gmail API, Google Calendar API, Google Docs API, Google Sheets API, Admin SDK API.
4. **Consent screen** (Google Auth Platform). Audience: **Internal**, so no Google verification is needed. Data access: add the scopes Ensemus asks for:
   - `openid`, `email`
   - `.../auth/drive.readonly`, `.../auth/drive.metadata.readonly`
   - `.../auth/admin.directory.group.readonly`
   - `.../auth/gmail.readonly`, `.../auth/gmail.compose`, `.../auth/gmail.send`
   - `.../auth/calendar.events`
   - `.../auth/drive.file`, `.../auth/documents`, `.../auth/spreadsheets`
5. **Client.** Create an OAuth client of type **Web application**, with authorized redirect URI `https://localhost:8443/api/v1/oauth/callback`. Keep the client ID. Save the client secret straight into a file (Part C), never into chat or a document.

## Part B: Microsoft test tenant and app

1. **Tenant.** A Microsoft 365 developer sandbox if you can get one, or a Microsoft 365 Business trial. Either must be used for nothing else.
2. **People and data.** Create `test-admin` (Global Administrator) and `test-member`, both licensed for Exchange and SharePoint. Create a Microsoft 365 group, `finance-test`, with `test-member` in it. Create a team with one channel. As `test-admin`, create a Word document and an Excel workbook in OneDrive, and share a text file with `finance-test` only.
3. **App.** In the Microsoft Entra admin center, App registrations, New registration. Supported account types: **Accounts in any organizational directory** (Ensemus's own app uses the `organizations` authority). Redirect URI: platform **Web**, `https://localhost:8443/api/v1/oauth/callback`.
4. **Secret.** Certificates and secrets, new client secret. Save the value straight into a file (Part C).
5. **Permissions.** API permissions, Microsoft Graph, **Delegated**: `openid`, `email`, `offline_access`, `Files.Read.All`, `Sites.Read.All`, `GroupMember.Read.All`, `User.Read.All`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `Files.ReadWrite`, `ChannelMessage.Send`, `Chat.ReadWrite`.
6. **Admin consent.** Click "Grant admin consent" for the test tenant. Several of these need it. Note whether the Ensemus consent page in Part D still asks `test-admin` to consent, and whether `test-member` is blocked without it.

## Part C: local stack

1. Start Docker Desktop. The build needs several GB free. Do not prune anything globally to make room.
2. Put each client secret in its own file, with nothing else in it:
   - `.local/secrets/oauth/google_client_secret`
   - `.local/secrets/oauth/microsoft_client_secret`
3. Copy `infrastructure/compose/suites-live.env.example` to `.local/suites-live.env` and fill in the two client IDs.
4. From the worktree root:

```bash
pnpm stack:secrets
```

```bash
docker compose --env-file .local/suites-live.env --profile connectors -f infrastructure/compose/compose.yaml -f infrastructure/compose/compose.test.yaml -f infrastructure/compose/compose.suites-live.yaml up -d --build --wait
```

5. Open `https://localhost:8443`. If the browser does not trust it, trust `.local/ensemus-local-root.crt` for this machine first. Sign up as the first owner, using the same address as the test tenant's `test-admin`, and invite `test-member` by their test address.

## Part D: connect

1. As the owner, open Connections. Connect **Google Workspace** with Files and Directory, using Ensemus's app. Name it starting with `TEST ` (for example `TEST Google`), because the live check refuses any other name. Sign in on Google's page as `test-admin` and approve.
2. Do the same for **Microsoft 365**, named `TEST Microsoft`, as `test-admin`.
3. Check each connection shows Connected, and that its granted permissions match what was asked for.
4. Sign in to Ensemus as `test-member`, open My connections, and connect Google and then Microsoft for Mail and Calendar, as `test-member` on each provider's page.

## Part E: check

**Files and directory.**

1. Start a sync of each organization connection from its page.
2. As `test-member`, search Ensemus for the text file shared with `finance-test`. It should appear for `test-member` and not for an Ensemus member outside the group.
3. Remove `test-member` from `finance-test` at the provider, sync again, and search again. It should be gone.

**Live check.** Run these from the worktree root, with the organization and connection IDs from the connection's address in Ensemus. Each prints one line per tool: an outcome code and counts, never content. Commands are in [the live check section](#live-check-commands).

## Part F: what to send back

- The JSON files the live check wrote (codes and counts only).
- Anything on an Ensemus page that looked wrong, as a screenshot with nothing private on it.
- The answer to Part B, step 6.

Then delete the test tenants' client secrets, or let the trials lapse.

## Live check commands

The check runs inside the connector worker with the worker's own code, so it reaches Google and Microsoft only through the same gateways. It refuses any connection whose name does not start with `TEST `. Its writes **skip approvals on purpose**: it checks wire formats, not the product path, and says so on its first line. It leaves its test drafts and calendar events in place, so delete them at the provider afterwards.

Replace `ORG`, `CONN` and the addresses with your own. Run each mode for `TEST Google` and then `TEST Microsoft`.

**Reads.** Add `--doc ID` or `--sheet ID --range A1:C3` for Google, or `--word DRIVE:ITEM` or `--workbook DRIVE:ITEM --range A1:C3` for Microsoft, to include documents.

```bash
docker compose --env-file .local/suites-live.env --profile connectors -f infrastructure/compose/compose.yaml -f infrastructure/compose/compose.test.yaml -f infrastructure/compose/compose.suites-live.yaml exec connector-worker node dist/live-suite-check.js --organization ORG --connection CONN --out /tmp/reads.json
```

**Directory.** Prints group, member and nested counts, and how many members matched someone here.

```bash
docker compose --env-file .local/suites-live.env --profile connectors -f infrastructure/compose/compose.yaml -f infrastructure/compose/compose.test.yaml -f infrastructure/compose/compose.suites-live.yaml exec connector-worker node dist/live-suite-check.js --organization ORG --connection CONN --directory --out /tmp/directory.json
```

**Writes** through the member's own connection: a draft, a calendar event created twice with one key, then updated, each reconciled. `--send-to-self` also sends one mail to the same address and looks for it by our Message-ID. For Microsoft, add `--teams TEAM:CHANNEL` to post one channel message.

```bash
docker compose --env-file .local/suites-live.env --profile connectors -f infrastructure/compose/compose.yaml -f infrastructure/compose/compose.test.yaml -f infrastructure/compose/compose.suites-live.yaml exec connector-worker node dist/live-suite-check.js --organization ORG --connection CONN --writes --self test-member@YOUR-TEST-DOMAIN --send-to-self --out /tmp/writes.json
```

**Copy a result out** to send back (repeat for each file):

```bash
docker compose --env-file .local/suites-live.env --profile connectors -f infrastructure/compose/compose.yaml -f infrastructure/compose/compose.test.yaml -f infrastructure/compose/compose.suites-live.yaml cp connector-worker:/tmp/reads.json .local/live-reads-google.json
```
