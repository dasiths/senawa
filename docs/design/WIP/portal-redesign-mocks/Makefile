# Serve the portal redesign mocks.
#
# These are static HTML with no build step. `make serve` is a plain file server
# so the pages behave the way they will in a browser rather than over file://.

PORT ?= 842
HERE := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

.DEFAULT_GOAL := help

.PHONY: help
help:
	@echo "make serve [PORT=842]   serve the mocks and print the URL"
	@echo "make open  [PORT=842]   serve, and open a browser at it"

.PHONY: serve
serve:
	@echo "Workflow   http://127.0.0.1:$(PORT)/"
	@echo "Agents     http://127.0.0.1:$(PORT)/agents.html"
	@echo "Artifacts  http://127.0.0.1:$(PORT)/artifacts.html"
	@echo "Record     http://127.0.0.1:$(PORT)/record.html"
	@cd $(HERE) && python3 -m http.server $(PORT) --bind 127.0.0.1

.PHONY: open
open:
	@cd $(HERE) && python3 -m http.server $(PORT) --bind 127.0.0.1 >/dev/null 2>&1 & \
	sleep 1; \
	"$${BROWSER:-xdg-open}" "http://127.0.0.1:$(PORT)/" >/dev/null 2>&1 || true; \
	echo "serving on http://127.0.0.1:$(PORT)/ — stop it with: pkill -f 'http.server $(PORT)'"
