# Drive the research/plan/implement workflow against a real Copilot agent.
#
# Everything here spends AI credits. Nothing runs until you ask it to.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# The senawa binary. Point at your install, or leave this to use the one built
# in this repository.
SENAWA ?= node $(abspath $(CURDIR)/../../apps/senawa/dist/main.js)

# This directory holds the workflow and the sensors. Sensors run here.
PROJECT := $(CURDIR)

# The agents write only here. It is deliberately not the directory holding the
# workflow: an agent's own session store may not live inside the tree it edits,
# and senawa refuses to start if it does.
WORKSPACE := $(PROJECT)/workspace

export SENAWA_REPOSITORY_DIR := $(WORKSPACE)
# Keep this run's authority out of your user state, so `make clean` is honest.
export XDG_STATE_HOME := $(PROJECT)/.senawa-state
export XDG_RUNTIME_DIR := $(PROJECT)/.senawa-state/run
# Without a loopback port the service has no portal listener.
export SENAWA_PORTAL_PORT ?= 0

REQUEST := $(PROJECT)/request.json
SOCKET := $(XDG_RUNTIME_DIR)/senawa/supervisor.sock

# A stopping supervisor holds its lock until the process is gone, and the next
# start fails while it does. Sleeping a fixed time is a race; waiting for the
# socket to disappear is not.
define wait_for_stop
	@for i in $$(seq 1 40); do [ -S "$(SOCKET)" ] || break; sleep 0.5; done
endef

.PHONY: help
help:
	@echo "make check      compile the workflow and report every problem at once"
	@echo "make service    start the local supervisor, with the portal listener on"
	@echo "make portal     print a one-time URL for the browser console"
	@echo "make run        write the request, start the run, and put the service on it"
	@echo "make advance    take one more step when the run is waiting"
	@echo "make status     what a run is doing, or the service when no run is named"
	@echo "make agents     who is working, on what, and on which model"
	@echo "make answer     answer the question an agent is waiting on"
	@echo "make approve    accept a phase that is waiting for a person"
	@echo "make steer      redirect the agent that is working"
	@echo "make stop       drain and stop the service"
	@echo "make game       show what the agents built"
	@echo "make clean      remove the run's state and everything the agents wrote"
	@echo ""
	@echo "Spends AI credits from 'copilot login'. See README.md."

.PHONY: check
check:
	@$(SENAWA) doctor

# Deliberately underspecified. The research agent is told to ask a person about
# what this leaves open, which is what `make answer` and the portal are for.
$(REQUEST):
	@printf '%s\n' '{"request": "Build me a tic-tac-toe game in Node.js."}' > $@
	@echo "wrote $@"

.PHONY: request
request: $(REQUEST)

.PHONY: service
service:
	@mkdir -p "$(XDG_RUNTIME_DIR)" "$(WORKSPACE)"
	@$(SENAWA) service start
	@$(SENAWA) service status

.PHONY: portal
portal:
	@$(SENAWA) portal

# The run is created first and the service is brought up onto it. `start` runs in
# its own process and writes the authority directly; a service that is already
# running does not notice, because it is woken from inside its own process. It
# picks the run up when it starts.
.PHONY: run
run: check $(REQUEST)
	@-$(SENAWA) service stop >/dev/null 2>&1
	$(call wait_for_stop)
	@mkdir -p "$(WORKSPACE)"
	@$(SENAWA) start $(REQUEST) --detach
	@$(MAKE) --no-print-directory service
	@echo ""
	@echo "The agents are working. Watch them with:"
	@echo "  make portal          a browser console"
	@echo "  make agents REPO=... RUN=...   who is working, on what"

.PHONY: advance
advance:
	@test -n "$(REPO)" -a -n "$(RUN)" || { \
		echo "usage: make advance REPO=<repository-id> RUN=<run-id>"; \
		echo "both are printed by 'make run' and shown in the portal"; \
		exit 2; \
	}
	@$(SENAWA) advance $(REPO) $(RUN)

.PHONY: status
status:
	@if [ -n "$(REPO)" ] && [ -n "$(RUN)" ]; then \
		$(SENAWA) status $(REPO) $(RUN); \
	else \
		$(SENAWA) service status; \
	fi

.PHONY: agents
agents:
	@test -n "$(REPO)" -a -n "$(RUN)" || { \
		echo "usage: make agents REPO=<repository-id> RUN=<run-id>"; \
		exit 2; \
	}
	@$(SENAWA) agent list $(REPO) $(RUN)

.PHONY: answer
answer:
	@test -n "$(REPO)" -a -n "$(RUN)" -a -n "$(TEXT)" || { \
		echo 'usage: make answer REPO=<repo> RUN=<run> TEXT="..."'; exit 2; \
	}
	@$(SENAWA) answer $(REPO) $(RUN) "$(TEXT)"

.PHONY: approve
approve:
	@test -n "$(REPO)" -a -n "$(RUN)" || { echo "usage: make approve REPO=<repo> RUN=<run>"; exit 2; }
	@$(SENAWA) approve $(REPO) $(RUN)

.PHONY: steer
steer:
	@test -n "$(REPO)" -a -n "$(RUN)" -a -n "$(TEXT)" || { \
		echo 'usage: make steer REPO=<repo> RUN=<run> TEXT="..." [WHEN=queued|live|abort-retry]'; exit 2; \
	}
	@$(SENAWA) steer $(REPO) $(RUN) "$(TEXT)" $(or $(WHEN),queued)

.PHONY: game
game:
	@test -d "$(WORKSPACE)" || { echo "nothing built yet; run 'make run'"; exit 1; }
	@find "$(WORKSPACE)" -type f -not -path '*/node_modules/*' | sed "s|$(WORKSPACE)/||"
	@echo ""
	@echo "check it the way the gate does:"
	@echo "  node scripts/check.mjs"

.PHONY: stop
stop:
	@-$(SENAWA) service drain >/dev/null 2>&1
	@-$(SENAWA) service stop >/dev/null 2>&1
	$(call wait_for_stop)
	@echo "service stopped"

.PHONY: clean
clean: stop
	@rm -rf "$(PROJECT)/.senawa-state" "$(WORKSPACE)" "$(REQUEST)"
	@echo "removed the run state and everything the agents wrote"
