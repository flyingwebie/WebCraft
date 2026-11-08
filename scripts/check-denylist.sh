#!/bin/sh
# Reference-material denylist check (ADR 0013, docs/reference-material.md).
#
# Fails when a tracked file, a commit message being added or a branch name matches the denylist:
# the names of third-party products that informed WebCraft and must never appear in anything
# tracked. It prints only where a match is (file and line, commit, branch), never a pattern or the
# matching text, so CI logs don't leak the list.
#
# The list holds one case-insensitive extended regular expression per line, read from
#   WEBCRAFT_DENYLIST       the list itself (CI fills it from the REFERENCE_DENYLIST secret), or
#   WEBCRAFT_DENYLIST_FILE  the path of a file holding it, kept outside the repo.
# With no list, the check fails in CI (when CI is set) and is skipped with a warning elsewhere.
#
# Usage:
#   scripts/check-denylist.sh                       tracked files in the working tree
#   scripts/check-denylist.sh --range BASE..HEAD    also the messages of the commits in the range
#   scripts/check-denylist.sh --branch NAME         also a branch name
#   scripts/check-denylist.sh --staged              staged files instead (the pre-commit hook)
#   scripts/check-denylist.sh --message-file FILE   only a commit message (the commit-msg hook)
set -eu

files=worktree
range=
branch=
message_file=
while [ $# -gt 0 ]; do
	case "$1" in
	--range) range=${2:?--range needs BASE..HEAD}; shift 2 ;;
	--branch) branch=${2:?--branch needs a name}; shift 2 ;;
	--staged) files=staged; shift ;;
	--message-file) message_file=${2:?--message-file needs a path}; files=none; shift 2 ;;
	-h | --help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
	*) echo "check-denylist: unknown option $1" >&2; exit 2 ;;
	esac
done

patterns=$(mktemp)
chmod 600 "$patterns"
trap 'rm -f "$patterns"' EXIT INT TERM

if [ -n "${WEBCRAFT_DENYLIST:-}" ]; then
	printf '%s\n' "$WEBCRAFT_DENYLIST" >"$patterns"
elif [ -n "${WEBCRAFT_DENYLIST_FILE:-}" ]; then
	if [ ! -r "$WEBCRAFT_DENYLIST_FILE" ]; then
		echo "check-denylist: WEBCRAFT_DENYLIST_FILE names a file that can't be read." >&2
		exit 2
	fi
	cat "$WEBCRAFT_DENYLIST_FILE" >"$patterns"
fi
# Drop carriage returns and blank lines: an empty pattern would match everything.
cleaned=$(tr -d '\r' <"$patterns" | grep -v '^[[:space:]]*$' || true)
printf '%s\n' "$cleaned" | grep -v '^$' >"$patterns" || true

if [ ! -s "$patterns" ]; then
	if [ -n "${CI:-}" ] && [ "${CI}" != "false" ]; then
		echo "check-denylist: no denylist given. Set WEBCRAFT_DENYLIST (from the REFERENCE_DENYLIST secret) in CI." >&2
		exit 1
	fi
	echo "check-denylist: no denylist given (WEBCRAFT_DENYLIST or WEBCRAFT_DENYLIST_FILE); skipping the check." >&2
	exit 0
fi
# grep exits 2 on a pattern it can't compile; say so without showing the pattern.
set +e
grep -E -i -f "$patterns" /dev/null >/dev/null 2>&1
if [ $? -eq 2 ]; then
	echo "check-denylist: the denylist holds a pattern that isn't a valid extended regular expression." >&2
	exit 2
fi
set -e

matches=$(mktemp)
trap 'rm -f "$patterns" "$matches"' EXIT INT TERM
sep=$(printf '\001')

# Prints "path:line" for each matching line of the tracked (or staged) files; never the text.
scan_files() {
	git grep -I -n -i -E -z "$@" -f "$patterns" -- . 2>/dev/null |
		tr '\000' "$sep" | cut -d "$sep" -f 1,2 | tr "$sep" ':' || true
}

case "$files" in
worktree)
	scan_files >>"$matches"
	git ls-files | grep -i -E -f "$patterns" | sed 's/^/file name: /' >>"$matches" || true
	;;
staged)
	scan_files --cached >>"$matches"
	git diff --cached --name-only --diff-filter=ACR | grep -i -E -f "$patterns" | sed 's/^/file name: /' >>"$matches" || true
	;;
esac

if [ -n "$message_file" ]; then
	# Lines starting with # are git's own instructions, not part of the message.
	if grep -v '^#' "$message_file" | grep -q -i -E -f "$patterns"; then
		echo "the commit message" >>"$matches"
	fi
fi

if [ -n "$range" ]; then
	case "$range" in
	0000000000000000000000000000000000000000..*) range=${range#*..} ;; # a new branch: every commit on it
	esac
	for commit in $(git rev-list "$range"); do
		if git log -1 --format=%B "$commit" | grep -q -i -E -f "$patterns"; then
			echo "the message of commit $commit" >>"$matches"
		fi
	done
fi

if [ -n "$branch" ] && printf '%s\n' "$branch" | grep -q -i -E -f "$patterns"; then
	echo "the branch name" >>"$matches"
fi

if [ -s "$matches" ]; then
	count=$(wc -l <"$matches" | tr -d ' ')
	echo "check-denylist: $count place(s) name reference material that must stay out of the repo:" >&2
	sed 's/^/  /' "$matches" >&2
	echo "Describe the feature by category instead (see docs/reference-material.md)." >&2
	exit 1
fi
echo "check-denylist: no denylisted names found."
