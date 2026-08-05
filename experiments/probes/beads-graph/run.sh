#!/usr/bin/env bash
# The bd contract and its behaviour under contention.
#
#   contract.sh     JSON envelope, metadata, state events, dependencies, gates,
#                   swarm validate, batch grammar, and per-command latency
#   concurrency.sh  atomic claiming and what concurrent writers actually do
#
# Spends no AI credits. Offline, and slow because bd init is slow.
set -euo pipefail
cd "$(dirname "$0")"

bash contract.sh
bash concurrency.sh
