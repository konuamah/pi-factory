# Codebase Constitution

## Agent Operating Summary
- Repository root: D:/projects/pi-factory
- Languages: JavaScript, TypeScript
- Package managers: npm
- Source roots: packages
- Docs roots: README.md
- API files: 0
- Data files: 4
- Tests: 0
- CI: not detected
- Deterministic areas evaluated: 120
- Refresh mode: FAST
- Changed files: 21
- Impacted areas: 1, 2, 3, 48, 50, 51
- Reused areas: none

## Project Snapshot
- Root: D:/projects/pi-factory
- Languages: JavaScript, TypeScript
- Package managers: npm
- Tracked files: 91
- Test files: 0
- CI files: 0
- Docs files: 1
- Script/tool files: 0
- API files: 0
- Data files: 4

## Status Legend
- DEFINED
- INFERRED
- NOT_DEFINED
- NOT_APPLICABLE
- UNCERTAIN

# Full Repository Constitution

## 1. Repository layout
- Status: DEFINED
- Finding: Tracked repository with 91 files and source roots in packages. Refresh impact routing marked this area as affected by recent file changes.
- Evidence: packages — source root

## 2. Monorepo / single-project model
- Status: INFERRED (HIGH)
- Finding: Repository appears to use a package-based monorepo layout. Refresh impact routing marked this area as affected by recent file changes.
- Evidence: package.json — workspace/manifests
- Evidence: packages/adapters/pi/package.json — workspace/manifests
- Evidence: packages/adapters/pi/tsconfig.json — workspace/manifests
- Evidence: packages/core/package.json — workspace/manifests
- Evidence: packages/core/tsconfig.json — workspace/manifests
- Evidence: packages/executors/fake/package.json — workspace/manifests
- Evidence: packages/executors/fake/tsconfig.json — workspace/manifests
- Evidence: packages/executors/pi/package.json — workspace/manifests
- Evidence: packages/executors/pi/tsconfig.json — workspace/manifests
- Evidence: packages/schemas/package.json — workspace/manifests
- Evidence: packages/schemas/tsconfig.json — workspace/manifests
- Evidence: tsconfig.json — workspace/manifests

## 3. Source directory organization
- Status: DEFINED
- Finding: Detected source roots: packages. Refresh impact routing marked this area as affected by recent file changes.
- Evidence: packages — source organization

## 4. Test directory organization
- Status: NOT_DEFINED
- Finding: No test files detected.

## 5. Documentation organization
- Status: NOT_DEFINED
- Finding: No CI configuration detected.

## 6. Script/tool directory organization
- Status: DEFINED
- Finding: Detected package scripts: build, typecheck, harness:pi-executor, harness:pi-runtime.
- Evidence: build: tsc -b
- Evidence: typecheck: tsc -b --pretty false
- Evidence: harness:pi-executor: node packages/executors/pi/dist/harness.js
- Evidence: harness:pi-runtime: node packages/executors/pi/dist/runtime-harness.js

## 7. Generated/build directory handling
- Status: INFERRED
- Finding: Generated/build directories are excluded from constitution scanning by policy.

## 8. Asset/static file organization
- Status: NOT_APPLICABLE
- Finding: No obvious asset/static file organization detected.

## 9. Package/dependency manager
- Status: DEFINED
- Finding: Detected package managers: npm.
- Evidence: package.json — package manager evidence
- Evidence: packages/adapters/pi/package.json — package manager evidence
- Evidence: packages/adapters/pi/tsconfig.json — package manager evidence
- Evidence: packages/core/package.json — package manager evidence
- Evidence: packages/core/tsconfig.json — package manager evidence
- Evidence: packages/executors/fake/package.json — package manager evidence
- Evidence: packages/executors/fake/tsconfig.json — package manager evidence
- Evidence: packages/executors/pi/package.json — package manager evidence
- Evidence: packages/executors/pi/tsconfig.json — package manager evidence
- Evidence: packages/schemas/package.json — package manager evidence
- Evidence: packages/schemas/tsconfig.json — package manager evidence
- Evidence: tsconfig.json — package manager evidence
- Evidence: package-lock.json — package manager evidence

## 10. Manifest files
- Status: DEFINED
- Finding: Detected manifests: package.json, packages/adapters/pi/package.json, packages/adapters/pi/tsconfig.json, packages/core/package.json, packages/core/tsconfig.json, packages/executors/fake/package.json, packages/executors/fake/tsconfig.json, packages/executors/pi/package.json, packages/executors/pi/tsconfig.json, packages/schemas/package.json, packages/schemas/tsconfig.json, tsconfig.json.
- Evidence: package.json — manifest file
- Evidence: packages/adapters/pi/package.json — manifest file
- Evidence: packages/adapters/pi/tsconfig.json — manifest file
- Evidence: packages/core/package.json — manifest file
- Evidence: packages/core/tsconfig.json — manifest file
- Evidence: packages/executors/fake/package.json — manifest file
- Evidence: packages/executors/fake/tsconfig.json — manifest file
- Evidence: packages/executors/pi/package.json — manifest file
- Evidence: packages/executors/pi/tsconfig.json — manifest file
- Evidence: packages/schemas/package.json — manifest file
- Evidence: packages/schemas/tsconfig.json — manifest file
- Evidence: tsconfig.json — manifest file

## 11. Lockfile strategy
- Status: DEFINED
- Finding: Detected lockfiles: package-lock.json.
- Evidence: package-lock.json — lockfile

## 12. Dependency version policy
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 13. Private registry/package source usage
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 14. Dependency vulnerability/licensing controls
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 15. Environment separation
- Status: NOT_DEFINED
- Finding: No environment separation files detected.

## 16. Environment variable conventions
- Status: NOT_DEFINED
- Finding: No environment variable convention evidence detected.

## 17. Secrets handling
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 18. Configuration hierarchy
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 19. Runtime/language version pinning
- Status: DEFINED
- Finding: Detected runtime/version pinning evidence in package.json, packages/adapters/pi/package.json, packages/core/package.json, packages/executors/fake/package.json, packages/executors/pi/package.json, packages/schemas/package.json.
- Evidence: package.json — runtime/version file
- Evidence: packages/adapters/pi/package.json — runtime/version file
- Evidence: packages/core/package.json — runtime/version file
- Evidence: packages/executors/fake/package.json — runtime/version file
- Evidence: packages/executors/pi/package.json — runtime/version file
- Evidence: packages/schemas/package.json — runtime/version file

## 20. Local development bootstrap
- Status: DEFINED
- Finding: Repository bootstrap/developer commands are script-driven: build, typecheck, harness:pi-executor, harness:pi-runtime.
- Evidence: build: tsc -b
- Evidence: typecheck: tsc -b --pretty false
- Evidence: harness:pi-executor: node packages/executors/pi/dist/harness.js
- Evidence: harness:pi-runtime: node packages/executors/pi/dist/runtime-harness.js

## 21. Containerized development/runtime configuration
- Status: NOT_APPLICABLE
- Finding: No containerized runtime configuration detected.

## 22. File naming conventions
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 23. Type/class/component naming
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 24. Variable/function naming
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 25. Constant naming
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 26. Import/export conventions
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 27. In-file organization
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 28. File size conventions
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 29. Function/method size conventions
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 30. Comment/documentation conventions
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 31. TODO/FIXME/HACK conventions
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 32. Overall application architecture
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 33. Module/package boundaries
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 34. Layering/dependency direction
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 35. Feature/domain organization
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 36. Shared/common code strategy
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 37. Dependency injection/inversion approach
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 38. Cross-module communication rules
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 39. Architectural boundary enforcement
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 40. API style/protocols
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 41. Route/endpoint organization
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 42. API versioning
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 43. Request validation
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 44. Response contracts
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 45. Error response format
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 46. Pagination/filtering conventions
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 47. Idempotency/rate-limit contract handling
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 48. Database/storage technologies
- Status: UNCERTAIN (LOW)
- Finding: Repository evidence exists for this area, but deterministic evaluation is not implemented yet. Refresh impact routing marked this area as affected by recent file changes.

## 49. ORM/query/data-access approach
- Status: UNCERTAIN (LOW)
- Finding: Repository evidence exists for this area, but deterministic evaluation is not implemented yet.

## 50. Model/schema organization
- Status: UNCERTAIN (LOW)
- Finding: Repository evidence exists for this area, but deterministic evaluation is not implemented yet. Refresh impact routing marked this area as affected by recent file changes.

## 51. Migration strategy
- Status: UNCERTAIN (LOW)
- Finding: Repository evidence exists for this area, but deterministic evaluation is not implemented yet. Refresh impact routing marked this area as affected by recent file changes.

## 52. Transaction boundaries
- Status: UNCERTAIN (LOW)
- Finding: Repository evidence exists for this area, but deterministic evaluation is not implemented yet.

## 53. Query performance conventions
- Status: UNCERTAIN (LOW)
- Finding: Repository evidence exists for this area, but deterministic evaluation is not implemented yet.

## 54. Indexing/data access conventions
- Status: UNCERTAIN (LOW)
- Finding: Repository evidence exists for this area, but deterministic evaluation is not implemented yet.

## 55. Seed/fixture/reference-data handling
- Status: UNCERTAIN (LOW)
- Finding: Repository evidence exists for this area, but deterministic evaluation is not implemented yet.

## 56. Error handling conventions
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 57. Timeout conventions
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 58. Retry/backoff policy
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 59. Circuit-breaking/failure isolation
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 60. Graceful degradation/fallbacks
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 61. Health/readiness/liveness checks
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 62. Idempotent operation handling
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 63. Authentication approach
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 64. Authorization/permission model
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 65. Input validation/sanitization
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 66. Output encoding/XSS controls
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 67. CSRF/CORS/browser security controls
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 68. Secrets scanning/storage
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 69. Dependency/SCA security scanning
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 70. Static code/security analysis
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 71. Encryption/TLS/data protection
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 72. Security headers/network trust boundaries
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 73. Test framework/tooling
- Status: NOT_DEFINED
- Finding: No test framework/tooling evidence detected.

## 74. Unit test conventions
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 75. Integration test conventions
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 76. End-to-end test conventions
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 77. Test naming/location conventions
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 78. Mock/fake/test-double strategy
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 79. Test data/factory/fixture strategy
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 80. Coverage/flaky-test/quality gates
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 81. Build commands/tooling
- Status: DEFINED
- Finding: Build command detected: tsc -b.
- Evidence: build: tsc -b

## 82. Development/start commands
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 83. Linting rules/tooling
- Status: NOT_DEFINED
- Finding: No linting rules/tooling detected.

## 84. Formatting rules/tooling
- Status: NOT_DEFINED
- Finding: No formatting rules/tooling detected.

## 85. Type checking/static analysis
- Status: DEFINED
- Finding: Type checking/static analysis evidence detected with command tsc -b --pretty false.
- Evidence: packages/adapters/pi/tsconfig.json — typecheck config
- Evidence: packages/core/tsconfig.json — typecheck config
- Evidence: packages/executors/fake/tsconfig.json — typecheck config
- Evidence: packages/executors/pi/tsconfig.json — typecheck config
- Evidence: packages/schemas/tsconfig.json — typecheck config
- Evidence: tsconfig.json — typecheck config
- Evidence: typecheck: tsc -b --pretty false

## 86. Repository automation scripts
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 87. CI/CD platform
- Status: NOT_DEFINED
- Finding: No CI/CD platform detected.

## 88. Pipeline stages
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 89. Branch/PR pipeline triggers
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 90. Required quality checks
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 91. Build artifact creation/retention
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 92. Pipeline dependency/build caching
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 93. Deployment automation
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 94. Logging format/conventions
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 95. Log levels and production logging
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 96. Request/trace/correlation IDs
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 97. Metrics instrumentation
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 98. Distributed tracing
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 99. Alerting/operational monitoring
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 100. Caching strategy
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 101. Async/background work
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 102. Payload/upload size controls
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 103. Connection/resource pooling
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 104. Performance profiling/benchmarking
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 105. Scalability/concurrency conventions
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 106. Branch naming/workflow
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 107. Commit message conventions
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 108. Pull request conventions
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 109. Review/approval requirements
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 110. Protected branch/force-push rules
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 111. Code ownership rules
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 112. Deployment model
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 113. Environment promotion strategy
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 114. Versioning/release strategy
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 115. Feature flag/release-control strategy
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 116. Rollback/recovery strategy
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 117. Sensitive/PII data handling
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 118. Audit/retention/access logging controls
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 119. Complexity/duplication/technical-debt controls
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.

## 120. Simplicity/reuse/anti-overengineering conventions
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.
