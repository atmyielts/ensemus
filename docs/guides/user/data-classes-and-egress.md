---
title: Data classes and what leaves
audience: user
area: agents
tickets: [SEC-01, AGENT-10, AGENT-11, SEC-02, SEC-04, SEC-13]
modes: [cloud, byom, sovereign]
status: written_untested
sources: [packages/policy/src/egress.ts, packages/policy/src/secret-scan.ts, packages/application/src/ai/context-source.ts]
tests: []
---

# Data classes and what leaves

> **Not yet tested end to end.** This page was written from the code, and nobody has followed it on a running system yet.

This guide describes the current code and has not yet been followed end to end on the release candidate.

Each source carries a data class: public, internal, confidential or restricted. Model routing applies the company's policy to the class of the context it would send. A model connection alone does not authorize every source to leave the company.

Before sending, a deterministic scan checks known secret formats, private-key blocks and configured canaries. A match raises that content to restricted. Refusal and audit records use codes rather than copying the detected secret. This scan catches known shapes; it does not promise that all sensitive text can be recognized automatically.

If a run reports that its context cannot leave, ask an owner to check the source classification and permitted model routes. Do not paste the blocked material into a less restricted field to get around the refusal. Access at the source and permission to send are both required.
