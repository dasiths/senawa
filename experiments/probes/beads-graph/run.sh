#!/usr/bin/env bash
# The bd contract and its behaviour under contention.
#
#   contract.sh     JSON envelope, metadata, state events, dependencies, gates,
#                   swarm validate, batch grammar, and per-command latency
#   concurrency.sh  atomic claiming and what concurrent writers actually do
#   fresh-read-benchmark.sh  correctness and descriptive fresh-read timings
#   commit-cost-benchmark.sh commit cost and its independence from graph size
#
# Spends no AI credits. Offline, and slow because bd init is slow.
set -euo pipefail
cd "$(dirname "$0")"

bash contract.sh
bash concurrency.sh
bash fresh-read-benchmark.sh \
	--profile smoke \
	--output "${TMPDIR:-/tmp}/senawa-beads-fresh-read-smoke.json"
bash commit-cost-benchmark.sh \
	--tasks 12 \
	--output "${TMPDIR:-/tmp}/senawa-beads-commit-cost.json"
