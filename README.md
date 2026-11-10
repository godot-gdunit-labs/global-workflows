# godot-gdunit-labs/global-workflows

Shared GitHub Actions workflows of the [godot-gdunit-labs](https://github.com/godot-gdunit-labs) organization.

* [`.github/workflows/formatting-checks.yml`](.github/workflows/formatting-checks.yml) is the shared formatting check for pull requests.
* [`formatting/`](formatting) holds the rules and scripts of the formatting check.
* [`.github/workflows/godot-release-check.yml`](.github/workflows/godot-release-check.yml) reports new Godot releases that the CI of a repository doesn't test yet.

The organization profile and community files live in [godot-gdunit-labs/.github](https://github.com/godot-gdunit-labs/.github).

## Formatting Checks

The formatting check runs one shared rule set on every pull request of the repositories selected by an organization ruleset.
All rules live in this repository, so a change to a rule is made once and applies to every selected repository.
The repositories need no workflow file of their own.

| Check                                      | Files                                                                  | Tool                                                                                 | Rules                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Line endings, final newline and whitespace | `*.yml`, `*.yaml`, `*.md`, `*.json`, `*.js`, `*.cjs`, `*.mjs`, `*.xml` | [editorconfig-checker](https://github.com/editorconfig-checker/editorconfig-checker) | [`.editorconfig`](formatting/.editorconfig)             |
| YAML                                       | `*.yml`, `*.yaml`                                                      | [yamllint](https://github.com/adrienverge/yamllint)                                  | [`.yamllint.yml`](formatting/.yamllint.yml)             |
| GitHub Actions workflows                   | `.github/workflows/*.yml`                                              | [actionlint](https://github.com/rhysd/actionlint)                                    | [`actionlint.yaml`](formatting/actionlint.yaml)         |
| Markdown                                   | `*.md`                                                                 | [markdownlint](https://github.com/DavidAnson/markdownlint)                           | [`.markdownlint.jsonc`](formatting/.markdownlint.jsonc) |
| JSON syntax                                | `*.json`                                                               | Node.js                                                                              |                                                         |
| XML syntax                                 | `*.xml`                                                                | [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser)            |                                                         |
| JavaScript                                 | `*.js`, `*.cjs`, `*.mjs`                                               | [ESLint](https://eslint.org)                                                         | [`eslint.config.mjs`](formatting/eslint.config.mjs)     |
| GDScript lint and format                   | `*.gd`                                                                 | [gdstyle](https://github.com/atelico/gdstyle)                                        | [`gdstyle.toml`](formatting/gdstyle.toml)               |
| C# format                                  | `*.cs`                                                                 | [dotnet format](https://github.com/dotnet/format)                                    | [`.editorconfig`](formatting/.editorconfig)             |

Only files tracked by git are checked. Files matching [`default-ignore.txt`](formatting/default-ignore.txt), such as `node_modules` or `.idea`, are skipped.
Every check runs even if an earlier one fails, and each finding is shown as an annotation on the changed file in the pull request.
The job summary lists the checked files, errors and warnings of each check and the files with findings.

### Enabling the Check

The check is enforced by an organization ruleset.
In the organization settings, open **Repository** > **Rulesets** and create a branch ruleset:

1. Target the repositories that should be checked, start with a few and add more once they pass.
2. Target the default branch only, as the rule blocks direct pushes to the targeted branches.
3. Enable **Require workflows to pass before merging** and add the workflow
   `.github/workflows/formatting-checks.yml` of the `godot-gdunit-labs/global-workflows` repository on the branch `main`.
4. Start with the enforcement status **Evaluate** to see the results without blocking merges, then switch to **Active**.

GitHub runs the workflow from this repository on every opened, updated or reopened pull request of the targeted repositories.
A pull request can't change or skip it, as it is not part of the checked repository.
Pull requests that were open before the ruleset was created need a new commit to start the check.

This repository must stay public, or its Actions settings must allow access from the other repositories of the organization,
so that the ruleset can run the workflow and the workflow can check out the formatting rules.

### Skipping Files

To skip more files of a repository, add a file named after the repository to [`formatting/ignore/`](formatting/ignore),
for example `formatting/ignore/gdUnit4.txt`, with one glob pattern per line matched against the path from the repository root:

```text
documentation/assets/**
**/resources/**
```

### Security

The check is safe for pull requests from forks, because nothing from the checked repository is executed:

* It runs on `pull_request` with a read-only token and no secrets, and the checkout keeps no credentials.
* The rules are checked out at the exact commit of the workflow, and configuration files of the checked repository are never loaded.
* Markdown and JavaScript are checked with the central configuration only,
  as both tools would otherwise run JavaScript configuration files found in the repository.
* C# files are checked with `dotnet format whitespace` in folder mode, which runs no `NuGet` restore and no `MSBuild`,
  so no project file or build script of the repository is loaded.
* npm packages are installed from the lockfile without install scripts, and downloaded tool binaries are verified by their SHA-256 checksum.
* Symlinked files are skipped, and tool output reaches the log only as escaped annotations.

### Updating the Rules and Tools

* Rules: change the files in [`formatting/`](formatting), the change applies to all repositories once it is merged to `main`.
* Actions and npm packages: [Dependabot](.github/dependabot.yml) opens a pull request every week.
* actionlint, editorconfig-checker, gdstyle, yamllint and the .NET SDK: update the version, and for the binaries the SHA-256 checksum,
  in the `env` section of the workflow.

## Godot Release Check

The release check runs every Monday and looks for new Godot releases that the CI of a repository doesn't test yet.
For each version line, such as `4.7`, only the latest release should be tested, for example `4.7.2` instead of `4.7` and `4.7.1`.
It keeps one open issue per repository that lists all needed updates.
Releases below the lowest Godot version a repository tests are ignored, and a release of a closed issue is not reported again,
unless the issue triage of the repository closed it with the `triage:failed` label.

The issue follows the task template of the repository, so it passes the issue triage:

* The issue form or Markdown template named `Task` is filled like the "New issue" page does, every required field gets a value.
  The check fails instead of creating an issue when a required field can't be filled.
* The labels, assignees, issue type and project of the template are applied, the generic `API` label is replaced by the `CI` label.
* The issue is created with its type in one step, and the title gets the ID prefix of the template afterwards.
* Repositories without a task template get a description and acceptance criteria.
* An open issue is rewritten when its body differs from the generated one.

The tested versions are read from the workflow files by a script, no LLM is involved:

* A `godot-version` key sets them as a matrix list (`['4.7', '4.7.1']`), a matrix `include` entry or a step input (`'4.8'`),
  a `godot-versions` key as a JSON list passed to a reusable workflow (`'["4.5.1", "4.6.2"]'`).
* The status comes from a `godot-status` or `godot-status-version` key of the same mapping, it is stable without one.
* Expressions such as `${{ inputs.godot-version }}` and commented out lines are ignored.
* Prereleases are only planned for repositories that already test one.

For each issue it also opens a pull request on the branch `TASK-<issue>` that updates these values, it never adds or removes lines:

* In a stable list, the replaced patches of a line are swapped for its latest release, and a new version line is added in version order.
* An `include` entry or step input is moved to the latest release of its own line, together with its status.
* An update without a list or entry to change, such as a new version line in a repository without a stable list, is listed in the issue as a manual change.
* The README is not changed.

When the plan changes, the pull request is updated, unless its branch has commits that were not made by the check.
A closed pull request is not opened again for the same plan.

The GitHub App needs the repository permissions **Issues**, **Contents**, **Pull requests** and **Workflows**
and the organization permission **Projects** with read and write access.

The checked repositories are listed in the workflow.
A manual run from the **Actions** tab can use `dry_run` to only show the result and the changes in the log.
