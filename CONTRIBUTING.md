# Contributing to jam

Thanks for your interest in contributing! This document explains how to propose changes.

By participating in this project you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs and requesting features

- Search [existing issues](https://github.com/jaypetez/jam/issues) first to avoid duplicates.
- Open a new issue using the **Bug report** or **Feature request** template and fill in every section.
- **Security vulnerabilities must not be reported in public issues.** Follow [SECURITY.md](SECURITY.md) instead.

## Making changes

1. Fork the repository and create a branch from `main`:

   ```sh
   git checkout -b my-change
   ```

2. Make your change. Keep each pull request focused on a single change; unrelated fixes belong in separate PRs.
3. Run the offline checks CI runs (Node 18+ required):

   ```sh
   npm ci
   ./check.sh
   ```

   CI also lints Markdown with [markdownlint-cli2](https://github.com/DavidAnson/markdownlint-cli2) and workflows with [actionlint](https://github.com/rhysd/actionlint). If you have a deployed Worker, `./run-tests.sh` runs the end-to-end suite (see [Tests](README.md#tests)).
4. Push your branch and open a pull request against `main`, filling in the pull request template.

## Review and merging

- Every pull request needs an approving review from the maintainer ([@jaypetez](https://github.com/jaypetez)) before it can be merged.
- All CI checks must pass and all review conversations must be resolved.
- Pushing new commits after approval dismisses the approval, so the latest changes are always reviewed.
- Pull requests are merged with **squash merge**, so write a clear PR title — it becomes the commit message on `main`.
- Workflows on pull requests from forks only run after a maintainer approves them.

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
