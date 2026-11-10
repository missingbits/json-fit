#!/bin/sh
# Agent benchmark: the same `issues` tool with its output limited to 12,000 characters by
#   full (no limit, control) | truncate-json | json-fit
#
#   bench/agent-bench.sh <agent> <model> [runs=5] [out=~/agent-bench/json-fit-<timestamp>-<agent>-<model>]
#   bench/agent-bench.sh --summary <out>
#
# agents:  claude (model: haiku | sonnet | opus)   codex (model: default | <openai model>)
# Results: <out>/run-N/<variant>/{answer.txt,stderr.txt,calls.log[,result.json]}
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)" # absolute path: agents may start a shell with a different default node
case "$("$NODE" -p "process.versions.node.split('.')[0]")" in 2[2-9]|[3-9]?) ;; *) echo "Node 22+ required ($NODE)" >&2; exit 1 ;; esac
VARIANTS="full truncate-json json-fit"

if [ "$1" = "--summary" ]; then "$NODE" --no-warnings "$HERE/score.ts" "$2"; exit 0; fi

AGENT="${1:?agent required: claude | codex}"
MODEL="${2:?model required (use 'default' for the agent default)}"
RUNS="${3:-5}"
OUT="${4:-$HOME/agent-bench/json-fit-$(date +%Y%m%d-%H%M%S)-$AGENT-$MODEL}"
PROMPT='Use the command-line tool ./issues (an issue tracker). Do not read its source code or any files.
Answer these questions:
1. How many issues are in the tracker in total?
2. List the ids of ALL open issues that have the label "security".
3. What root cause is described in issue #143?
Finish with exactly these three lines:
TOTAL: <number>
SECURITY_OPEN: <comma-separated ids, ascending>
ROOT_CAUSE_143: <one sentence>'

setup() { # setup <dir> <variant>: a wrapper that runs the CLI and logs every call
  mkdir -p "$1"
  cat >"$1/issues" <<EOF
#!/bin/sh
out=\$(ISSUES_VARIANT=$2 "$NODE" --no-warnings "$HERE/issues.ts" "\$@"); code=\$?
printf '%s\n' "\$out"
printf '%s\t%s\t%s\t%s\n' "\$(date +%H:%M:%S)" "issues \$*" "exit=\$code" "stdout=\${#out}" >>"$1/calls.log"
exit \$code
EOF
  chmod +x "$1/issues"
  : >"$1/calls.log"
}

run_agent() { # runs inside the variant folder (a subshell)
  unset AI_AGENT CLAUDECODE CLAUDE_CODE CODEX_SANDBOX CODEX_CI CODEX_THREAD_ID
  case "$AGENT" in
    claude)
      claude -p "$PROMPT" --model "$MODEL" --allowedTools "Bash(./issues:*)" "Bash(./issues *)" \
        --strict-mcp-config --no-session-persistence --output-format json >result.json
      jq -r '.result // empty' result.json ;;
    codex)
      if [ "$MODEL" = default ]; then set --; else set -- -m "$MODEL"; fi
      codex exec "$@" --skip-git-repo-check --ephemeral -s workspace-write -C "$PWD" "$PROMPT" ;;
    *) echo "unknown agent: $AGENT" >&2; exit 2 ;;
  esac
}

mkdir -p "$OUT"
echo "agent=$AGENT model=$MODEL runs=$RUNS out=$OUT"
i=1
while [ "$i" -le "$RUNS" ]; do
  for v in $VARIANTS; do
    d="$OUT/run-$i/$v"
    setup "$d" "$v"
    (cd "$d" && run_agent </dev/null >answer.txt 2>stderr.txt || echo "agent exit $?" >>stderr.txt) &
  done
  wait
  echo "run $i/$RUNS done"
  i=$((i + 1))
done
"$NODE" --no-warnings "$HERE/score.ts" "$OUT"
