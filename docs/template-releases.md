# Template versions and releases

The template is distributed through annotated Git tags and GitHub Releases.
The [changelog](../CHANGELOG.md) records user-facing changes, migration links,
verification and known limits. The [starter guide](starter.md) remains the
reference for current engine behavior.

Template versions follow semantic versioning for the source and documented
engine integration API: incompatible changes increment the major version,
compatible features the minor version, and compatible fixes the patch version.
For example, v2.0.0 changes renderer hooks and resource ownership, so existing
custom integrations follow its [migration guide](migrations/v2.0.0.md).

The private npm and Cargo packages are scaffolding for a new game. Their
`0.1.0` versions are independent of the template tag, as they were in v1.0.0.
Use `git describe --tags --always` to identify the template revision before
starting a game's own Git history. A template release is a source release;
GitHub supplies its ZIP/tar archives. Building a game regenerates WASM and
browser output with the documented commands.

## Publishing a template release

1. Review changes since the previous tag. Update the changelog, add a migration
   guide for breaking changes, and link it from the README and affected guide.
2. Verify the release's runtime changes and retain their exact build receipts.
   Use both renderer smoke checks and `test:graphics` when graphics change;
   verify that a clean export still works without add-ons. If the release
   preparation changes documentation only, identify and reuse the earlier
   implementation results rather than describing them as a fresh tagged build.
3. Validate documentation links, skill integrity and the intended staged diff.
   Follow the commit rules in [AGENTS.md](../AGENTS.md).
   Commit the release documentation before tagging a clean, reviewed revision.
4. Create an annotated `v<major>.<minor>.<patch>` tag. With user authorization,
   push the intended branch and that exact tag, then publish a GitHub Release
   using `gh release create <tag> --verify-tag --notes-file <notes-file>`.
   Verify the remote tag's peeled commit and the published release URL. Release
   notes must identify breaking changes, checks and material limitations.

Do not move a published tag to include later fixes; create another release.
Publishing this repository's source does not deploy any game. The game package
and host workflow is documented separately in [release.md](release.md).
