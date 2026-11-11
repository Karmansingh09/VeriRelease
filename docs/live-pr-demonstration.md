# VeriRelease — Live Pull Request Evidence Verification Demonstration

This document serves as the deliverable change for testing live GitHub Pull Request harvesting, automated evidence collection, AI evaluation, and deterministic policy authorization in VeriRelease.

## Acceptance Criteria Validation

1. **Criterion 1: Documentation & Specification**
   - Verified that deliverable pull request documentation exists and adheres to VeriRelease standards.
2. **Criterion 2: Cryptographic Tamper-Evidence**
   - Commit SHA and repository metadata are harvested directly into an immutable `GitHubEvidenceSnapshot`.
   - Complete RFC 8785 canonical JSON SHA-256 evidence hash generated.
3. **Criterion 3: Deterministic Policy Engine Compliance**
   - Policy evaluates evidence against criteria frozen at submission time.
   - Payout eligibility requires all mandatory criteria to pass.
