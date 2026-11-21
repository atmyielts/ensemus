// The containers the release gates run, each by digest, because a tag can move and a scanner or SBOM tool
// that changes under us would change what the gates mean. check-pins.mjs reads this file, and none of
// these reach what ships. Syft and Grype are both Apache-2.0 (ADR-037 D2).
export const SYFT = {
  image:
    'anchore/syft:v1.56.0@sha256:697ae864af1299cfa43c54b161cea3dd65c6d54de82e3dba66ea3dccb3acc313',
};
export const GRYPE = {
  image:
    'anchore/grype:v0.121.2@sha256:6a36234da13f9faa327306ac0b3dab3405cfa2b4eb20c8f904125a8707863913',
};
// The air-gap gate's probe container, which tries to reach the outside from inside the stack's networks.
export const NETSHOOT = {
  image:
    'nicolaka/netshoot:v0.14@sha256:7f08c4aff13ff61a35d30e30c5c1ea8396eac6ab4ce19fd02d5a4b3b5d0d09a2',
};
