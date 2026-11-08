# Files from an imported archive

Imported files are kept separately for review. The archive does not prove which private sources or records each file used, so importing one does not make it an ordinary attachment or approve it for assistant use. Work file links from the archive remain inactive.

The owner who requested the import can open **Administration → Export and import → Files awaiting review**. A file becomes downloadable only after its storage write and exact read-back are confirmed and current permission checks pass. Download a ready file, inspect it, and, when appropriate, attach it yourself through **Files** on the right piece of work. That action creates a new human upload with a new identity. It does not certify the original file's provenance.

Because original inputs are unknown, current sources and records are treated conservatively as possible inputs. An unrelated private or closed source/record can therefore block review. The page can still show safe status and size while withholding private filenames and content. Large or unverifiable input inventories refuse download; they are not treated as empty.

If a file says **Operator attention needed**, do not repeatedly upload the archive to resend that write. A failed storage request can still be active or can have completed after its response was lost. A missing object in one HEAD request does not prove the old writer stopped. The retained write token remains uncertain until the actual storage lifecycle authority proves quiescence. This source change does not add a self-service reset or an operator command that fabricates that proof.

Source/record closure blocks review immediately. Actual physical cleanup also requires current hold checks, a settled or positively fenced writer, deletion of the exact private key, and independently verified absence. Missing lifecycle bindings leave cleanup incomplete. Restore checks include old purged receipts and newer storage orphans; reappearing bytes invalidate an old receipt and remain blocked. The customer's original archive outside this deployment is not erased by local cleanup.

Implementation and runtime gates for this followup are recorded in `docs/06-delivery/evidence/M6-archive-file-quarantine-source.md`. This operator note describes the intended source behavior; the joined migration, storage, HTTP/browser and recovery gates remain unrun until their actual evidence is recorded.
