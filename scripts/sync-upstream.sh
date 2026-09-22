#!/usr/bin/env bash
# Sync this fork (origin) with upstream/main, then push so Railway redeploys.
#
#   ./scripts/sync-upstream.sh            # fetch, merge upstream/main, push origin main
#   ./scripts/sync-upstream.sh --dry-run  # report what would merge; change nothing
#
# Driven by the `ue` zsh function, but safe to run by hand.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BRANCH="${SYNC_BRANCH:-main}"
UPSTREAM_REMOTE="${SYNC_UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${SYNC_UPSTREAM_BRANCH:-main}"
ORIGIN_REMOTE="${SYNC_ORIGIN_REMOTE:-origin}"

dry_run=0
for arg in "$@"; do
  case "$arg" in
    -n | --dry-run) dry_run=1 ;;
    -h | --help)
      cat <<'EOF'
Sync the Executor fork with upstream/main and push, so Railway redeploys.

Usage: ue [--dry-run]

  -n, --dry-run   Fetch and report what would merge; no upstream merge, no push.
  -h, --help      Show this help.

Env overrides: SYNC_BRANCH, SYNC_UPSTREAM_REMOTE, SYNC_UPSTREAM_BRANCH,
SYNC_ORIGIN_REMOTE.
EOF
      exit 0
      ;;
    *)
      echo "sync-upstream: unknown argument '$arg' (try --help)" >&2
      exit 2
      ;;
  esac
done

log() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die() {
  printf '\033[31m%s\033[0m\n' "$*" >&2
  exit 1
}

for remote in "$ORIGIN_REMOTE" "$UPSTREAM_REMOTE"; do
  git remote get-url "$remote" >/dev/null 2>&1 ||
    die "sync-upstream: remote '$remote' is not configured."
done

current="$(git symbolic-ref --quiet --short HEAD || true)"
if [[ "$current" != "$BRANCH" ]]; then
  if git worktree list --porcelain | grep -q "^branch refs/heads/$BRANCH$"; then
    die "sync-upstream: '$BRANCH' is checked out in another worktree; run ue from there."
  fi
  log "Checking out $BRANCH (was on ${current:-detached HEAD})"
  git checkout "$BRANCH"
fi

# A dirty tree would make the merge (and a conflict abort) ambiguous: stop early.
if [[ -n "$(git status --porcelain)" ]]; then
  git status --short
  die "sync-upstream: working tree has uncommitted changes; commit or stash them first."
fi

log "Fetching $ORIGIN_REMOTE and $UPSTREAM_REMOTE..."
git fetch --quiet --prune "$ORIGIN_REMOTE" "$BRANCH"
git fetch --quiet --prune "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"

# Pick up anything pushed to the fork from another machine/worktree first.
if [[ "$(git rev-list --count "HEAD..$ORIGIN_REMOTE/$BRANCH")" -gt 0 ]]; then
  if [[ "$(git rev-list --count "$ORIGIN_REMOTE/$BRANCH..HEAD")" -eq 0 ]]; then
    log "Fast-forwarding to $ORIGIN_REMOTE/$BRANCH..."
    git merge --ff-only "$ORIGIN_REMOTE/$BRANCH"
  else
    log "Rebasing local commits onto $ORIGIN_REMOTE/$BRANCH..."
    if ! git rebase "$ORIGIN_REMOTE/$BRANCH"; then
      git rebase --abort 2>/dev/null || true
      die "sync-upstream: rebase hit conflicts; resolve manually, then run ue again."
    fi
  fi
fi

behind="$(git rev-list --count "HEAD..$UPSTREAM_REMOTE/$UPSTREAM_BRANCH")"
if [[ "$behind" -eq 0 ]]; then
  log "Already up to date with $UPSTREAM_REMOTE/$UPSTREAM_BRANCH. Nothing to deploy."
  exit 0
fi

log "$behind commit(s) to merge from $UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
git --no-pager log -n 20 --oneline --no-decorate "HEAD..$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
[[ "$behind" -gt 20 ]] && echo "... and $((behind - 20)) more"

if [[ "$dry_run" -eq 1 ]]; then
  log "Dry run: no merge, no push."
  exit 0
fi

pre_merge="$(git rev-parse HEAD)"
log "Merging $UPSTREAM_REMOTE/$UPSTREAM_BRANCH into $BRANCH..."
if ! git merge --no-edit "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"; then
  conflicts="$(git diff --name-only --diff-filter=U || true)"
  git merge --abort 2>/dev/null || true
  warn "Merge hit conflicts - aborted so the checkout stays clean."
  if [[ -n "$conflicts" ]]; then
    warn "Conflicting files:"
    echo "$conflicts" | sed 's/^/  /' >&2
  fi
  die "Resolve the merge (or ask an agent), then run ue again."
fi

if ! git diff --quiet "$pre_merge..HEAD" -- bun.lock package.json; then
  warn "bun.lock/package.json changed: run 'bun install' before local work."
fi

log "Pushing $BRANCH to $ORIGIN_REMOTE..."
git push "$ORIGIN_REMOTE" "$BRANCH"

log "Pushed $(git --no-pager log -1 --format='%h %s')"
echo
echo "Railway builds from $ORIGIN_REMOTE/$BRANCH on push:"
echo "  https://executor.aiacquisition.com   (build ~5 min)"
echo "  https://executor.acquisity.ai"
