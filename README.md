# mend

[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fun5572/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fun5572/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend applies unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON text edits to a tree of files. It runs on Node.js 22.18 or later and uses the Node.js standard library.

Run from the root of the tree to edit.

```sh
node /path/to/mend/main.ts --check edit.patch
node /path/to/mend/main.ts edit.patch
```

Use `-` to read the patch from stdin and `--strict` to require exact line matches.
