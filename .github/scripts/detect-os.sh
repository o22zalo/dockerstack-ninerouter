#!/usr/bin/env bash
# Path: .github/scripts/detect-os.sh
# Detects the true OS via uname (not RUNNER_OS).
# Writes CUR_OS, DOCKER_SOCK, COMPOSE_PROFILES, STACK_NAME,
# COMPOSE_PROJECT_NAME, WSL_WORKSPACE to .env + CI env.
set -euo pipefail

UNAME_S="$(uname -s)"
UNAME_R="$(uname -r)"

echo "=== [detect-os] uname -s: $UNAME_S | uname -r: $UNAME_R ==="

if echo "$UNAME_R" | grep -qi "microsoft\|wsl"; then
  CUR_OS="windows"
  DOCKER_SOCK="/var/run/docker.sock"
elif [ "$UNAME_S" = "Darwin" ]; then
  CUR_OS="macos"
  DOCKER_SOCK="/var/run/docker.sock"
elif echo "$UNAME_S" | grep -qi "MINGW\|MSYS\|CYGWIN"; then
  CUR_OS="windows"
  DOCKER_SOCK="/var/run/docker.sock"
else
  CUR_OS="linux"
  DOCKER_SOCK="/var/run/docker.sock"
fi

echo "  → CUR_OS=$CUR_OS"

# Workspace
CUR_WORK_DIR="${GITHUB_WORKSPACE:-${BUILD_SOURCESDIRECTORY:-$(pwd)}}"
CUR_WHOAMI="$(whoami)"
# STACK_NAME / COMPOSE_PROJECT_NAME derived from directory name
COMPOSE_PROJECT_NAME="$(basename "$CUR_WORK_DIR")"

# WSL path conversion
WSL_WORKSPACE=""
if [ "$CUR_OS" = "windows" ]; then
  if command -v wslpath &>/dev/null; then
    WSL_WORKSPACE="$(wslpath -u "$CUR_WORK_DIR" 2>/dev/null || echo "$CUR_WORK_DIR")"
  else
    WIN_PATH="${CUR_WORK_DIR//\\//}"
    DRIVE="${WIN_PATH:0:1}"; DRIVE_LOWER="${DRIVE,,}"; PATH_REST="${WIN_PATH:2}"
    WSL_WORKSPACE="/mnt/${DRIVE_LOWER}${PATH_REST}"
  fi
  echo "  → WSL_WORKSPACE=$WSL_WORKSPACE"
fi

# ── Append to .env ────────────────────────────────────────────────
{
  echo "CUR_OS=$CUR_OS"
  echo "DOCKER_SOCK=$DOCKER_SOCK"
  echo "COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME"
  echo "CUR_WORK_DIR=$CUR_WORK_DIR"
  echo "CUR_WHOAMI=$CUR_WHOAMI"
  [ -n "$WSL_WORKSPACE" ] && echo "WSL_WORKSPACE=$WSL_WORKSPACE"
} >> .env

# ── Export to CI env ──────────────────────────────────────────────
set_ci_var() {
  local name="$1" value="$2"
  [ -n "${GITHUB_ENV:-}" ]  && echo "${name}=${value}" >> "$GITHUB_ENV"
  [ -n "${TF_BUILD:-}" ]    && echo "##vso[task.setvariable variable=${name}]${value}"
  export "${name}=${value}"
}

set_ci_var "CUR_OS"               "$CUR_OS"
set_ci_var "DOCKER_SOCK"          "$DOCKER_SOCK"
set_ci_var "COMPOSE_PROJECT_NAME" "$COMPOSE_PROJECT_NAME"
[ -n "$WSL_WORKSPACE" ] && set_ci_var "WSL_WORKSPACE" "$WSL_WORKSPACE"

echo "✅ [detect-os] CUR_OS=$CUR_OS"
