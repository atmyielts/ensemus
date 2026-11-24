---
title: Signing in
audience: user
area: admin
tickets: [ID-03, FOUND-02]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [apps/web/src/app/sign-in/page.tsx, apps/web/src/app/sign-up/page.tsx, apps/web/src/app/setup/page.tsx, apps/web/src/app/page.tsx, apps/web/src/app/not-found.tsx, apps/web/src/app/restoring/route.ts, apps/web/src/server/actions.ts, apps/web/src/server/actor.ts, apps/web/src/server/organizations.ts, apps/web/src/server/tenant.ts, apps/web/src/server/runtime.ts, apps/web/src/lib/return-path.ts, packages/auth/src/index.ts, tests/stack/first-owner.test.ts, tests/stack/server-actions.test.ts, tests/integration/auth.test.ts]
tests: []
---

# Signing in

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

You sign in with an email and a password, on the page headed **Sign in to Ensemus**. If you open a page that needs an account while signed out, you are taken there.

## Sign in

1. Enter your **Email** and **Password**.
2. Select **Sign in**.

Where you land depends on your account:

| Your account has | You see |
|---|---|
| No organization | **Set up your organization** |
| One organization | That organization's home page |
| More than one organization | **Your organizations**, a list with your role in each |
| An invitation you followed here | The invitation again, so you can accept it |

## If you have no account yet

The line below the form tells you which way in your deployment uses. Whoever runs the deployment chooses.

- **New here? Create an account** opens **Create your account**. Enter your **Name**, **Email** and **Password**, then select **Create account**.
- **Given a setup code? Use it here** opens **Set up your account**. Enter the **Setup code** that whoever runs your deployment gave you, then your details, then select **Create account**. A code works once, for one account.

A password has at least 12 characters and at most 128. You are signed in as soon as the account exists.

## Staying signed in, and signing out

You stay signed in for seven days from when your session was last renewed, and using Ensemus renews it. When a session ends, the next page you open takes you to the sign-in page.

Select **Sign out** to end your session in this browser. You go back to the sign-in page. A session in another browser stays until it ends by itself.

## What it cannot do

- **It cannot recover a lost password.** There is no reset link, and no page for changing a password. Ask whoever runs your deployment. A setup code makes a new account, and does not recover an old one.
- **It offers only email and password.** The page has no button for a company identity provider, even where your deployment has one connected. See [Single sign-on](sso.md).
- **It asks for no second factor.** See [Multi-factor sign-in for privileged actions](mfa.md).
- **It does not say whether an address has an account.** A wrong password and an unknown address get the same answer, so nobody can use this page to find out who has an account.

## When it refuses

| What you see | What it means | What to do |
|---|---|---|
| That email and password did not match. | The email or the password is wrong, or no account uses that address. It does not say which. | Check both, and try again. If you have lost the password, ask whoever runs your deployment. |
| Too many attempts from here. Wait a minute, then try again. | Too many tries came from your network address in a short time. Your password may be right. | Wait a minute, then try once, carefully. |
| That setup code does not work. It may have been used already, or run out. Ask whoever runs this deployment for a new one. | The code has been used, has run out, or was mistyped. | Check it for typing mistakes, then ask for a new one. |
| We could not create that account, and your setup code still works. Check your details, and use a password of at least 12 characters. | The details were refused. The code was not used up. | Fix the details and send the form again. If that address already has an account, sign in instead. |
| We could not create that account. Check your details, and use a password of at least 12 characters. | The details were refused, or that address already has an account. | Fix the details, or sign in instead. |
| **Page not found** when you open the sign-up page | Sign-up is off on this deployment. | Ask whoever runs your deployment for a setup code. |
| **Page not found**: This page does not exist, or you do not have access to it. | You are not a member of that organization, your access was disabled, or it does not exist. All three get the same answer, so nobody outside an organization can learn that it exists. | Check the address, then ask an owner or admin of that organization. The refused attempt is recorded. |
| **Set up your organization**, when you expected to see your organization | This account has no organization you can use. You may have used another email address, or your access may have been disabled. | Check the email address shown on the page, then ask an owner or admin of the organization. A new organization starts empty, and does not bring your work back. |
| **This organization is being restored** | Your administrator is restoring it from a backup, and it stays unavailable until that finishes. | Try again later, or ask your administrator how it is going. |

## Other organizations

One account can belong to several organizations. Signing in gives you only those you are a member of, and if your access to one is disabled, it stops at your next request.

## Where modes differ

Signing in works the same in all three modes. Whether sign-up is open depends on the deployment and not on its mode, and it stays off unless whoever runs the deployment turns it on.
