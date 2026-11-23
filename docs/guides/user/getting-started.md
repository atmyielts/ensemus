---
title: Getting started
audience: user
area: start
tickets: [ID-01, UX-11]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/app/page.tsx, apps/web/src/app/sign-up/page.tsx, apps/web/src/app/sign-in/page.tsx, apps/web/src/app/setup/page.tsx, apps/web/src/app/not-found.tsx, apps/web/src/app/error.tsx, apps/web/src/app/o/[organizationId]/layout.tsx, apps/web/src/app/o/[organizationId]/error.tsx, apps/web/src/app/o/[organizationId]/not-found.tsx, apps/web/src/server/actions.ts, apps/web/src/server/tenant.ts, apps/web/src/lib/messages.ts, packages/auth/src/index.ts, packages/contracts/src/index.ts, tests/stack/product-flows.test.ts]
tests: []
---

# Getting started

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

Ensemus keeps your organization's work, people and approvals in one place. This page takes you from having no account to your first piece of work.

## Get an account

How you get an account depends on how your deployment is set up.

- If the sign-in page says **New here? Create an account**, choose **Create an account**. Fill in **Name**, **Email** and **Password**, then press **Create account**.
- If it says **Given a setup code? Use it here**, sign-up is off. Whoever runs your deployment gives you a setup code. Choose **Use it here**, fill in **Setup code**, **Name**, **Email** and **Password**, then press **Create account**.
- If someone invited you, open their link first and follow [Inviting people](members-and-invitations.md).

A password needs at least 12 characters. A setup code works once, for one account.

## Create your organization

When you are signed in and belong to no organization, you see **Set up your organization**.

1. Fill in **Organization name**, up to 120 characters.
2. Read **Who is responsible for your data**. It says which kind of deployment this is.
3. Press **Create organization**.

You become the organization's owner, and its [Home page](home.md) opens. Pressing the button twice makes one organization.

## Who is responsible for your data

The page shows the statement for your deployment, in these words.

### Ensemus Cloud

- "Ensemus hosts this service and stores your organization’s data. The data stays yours."
- "Ensemus supplies the approved AI model providers. Content may be sent to those providers under the applicable terms and your organization’s policy."

### Ensemus with your own models

- "Ensemus hosts this service and stores your organization’s data. The data stays yours."
- "For third-party providers, you connect models with your own keys and pay those providers directly."
- "Ensemus still processes your data in the hosted service."

### Ensemus Sovereign

- "Your organization runs Ensemus on infrastructure it controls, including the database, the file storage and the AI models."
- "This installation can run independently of Ensemus-hosted services. Diagnostics leave only if you choose to send them."
- "Your organization is responsible for operating, securing and backing up this installation, and for what its models cost."

AI features use models approved for your organization. Your organization’s policy controls what data those models can receive.

## Find your way around

On wider screens, use the menu on the left to move between workspace pages. On phones, **Home**, **Work**, **Approvals** and **Inbox** stay in the bottom bar. Open **More** for the full menu and your account. **Approvals** and **Inbox** show a number when something is waiting for you.

Next steps:

1. Press **New work** and describe the outcome you want. See [Work Units](work-units.md).
2. Open **People and teams** and invite someone. See [Inviting people](members-and-invitations.md).
3. Open **Clients and projects** if you want to group work. See [Clients and projects](clients-and-projects.md).

## If you belong to several organizations

**Switch organization** appears in the menu when you have more than one, and lists **Your organizations**, with your role in each: **Owner**, **Admin** or **Member**. If you belong to only one, it opens straight away after you sign in.

Each organization is separate. What you see in one tells you nothing about another, and your role in one gives you nothing in another.

## What it will not do

- It offers **Create organization** only while you belong to none. Once you are in an organization, this form is not shown.
- The sign-in page has no forgotten-password link. See [Signing in](sign-in.md).

## When it refuses

| You see | What it means | What to do |
|---|---|---|
| That email and password did not match. | One of them is wrong, or there is no such account. It does not say which | Check both, and try again |
| Too many attempts from here. Wait a minute, then try again. | There were too many tries in a short time | Wait a minute |
| We could not create that account. Check your details, and use a password of at least 12 characters. | The account was not made. It does not say why, so it cannot be used to find out who has an account | Check your details and your password's length |
| That setup code does not work. It may have been used already, or run out. Ask whoever runs this deployment for a new one. | The code cannot be used | Ask for a new code |
| We could not create that account, and your setup code still works. Check your details, and use a password of at least 12 characters. | The code was fine, and the details were not | Check your details, and use the same code |
| Enter a name of up to 120 characters. | The organization name is empty or too long | Change the name |
| Page not found. This page does not exist, or you do not have access to it. | The same answer for both, so nobody can find out what exists elsewhere. **Create an account** also answers this where sign-up is off | Check the link, or ask someone in the organization for access |
| You do not have permission to do that. | Your role does not allow this | Ask an owner or admin |
| This organization is being restored | Your administrator is restoring it from a backup. See [What happens to deleted content](deleted-content.md) | Try again later, or ask your administrator how it is going |

If a page cannot be shown, you see **Something went wrong** or **This page could not be shown**, with **Try again**. Nothing you saved has been lost. If it keeps happening, give your administrator the reference shown on the page.
