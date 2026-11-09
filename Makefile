# Entry points for building, checking and deploying the sample. `make help` lists them.
# CONFIG names the deployment: infra/envs/dev/$(CONFIG).tfvars and backend/$(CONFIG).s3.tfbackend.

CONFIG ?= dev
export AWS_REGION ?= us-east-1

TF_DIR  := infra/envs/dev
TFVARS  := $(TF_DIR)/$(CONFIG).tfvars
BACKEND := $(TF_DIR)/backend/$(CONFIG).s3.tfbackend
TF      := terraform -chdir=$(TF_DIR)

.DEFAULT_GOAL := help
.PHONY: help install check config models plan deploy user destroy

help: ## List the targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-z-]+:.*## / {printf "  %-9s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install dependencies
	npm ci

check: ## Tests (no paid model calls), typecheck and web build
	npm test
	npm run typecheck
	npm run web:build

config: ## Create the CONFIG tfvars and backend files from the examples
	@test -f $(TFVARS) || { cp $(TF_DIR)/openai-direct.example.tfvars $(TFVARS); echo "created $(TFVARS)"; }
	@test -f $(BACKEND) || { cp $(TF_DIR)/backend/example.s3.tfbackend $(BACKEND); echo "created $(BACKEND)"; }
	@echo "edit both files, then: make deploy CONFIG=$(CONFIG)"

models: ## List the registry models your AWS credentials can call
	npm run models:check

plan: ## Bundle and show the Terraform plan; changes nothing
	./deploy.sh $(CONFIG) --plan-only

deploy: ## Bundle, plan, confirm, apply, then publish the web UI
	./deploy.sh $(CONFIG)

user: ## Create a Cognito user: make user EMAIL=you@example.com
	@test -n "$(EMAIL)" || { echo "usage: make user EMAIL=you@example.com" >&2; exit 2; }
	aws cognito-idp admin-create-user --username "$(EMAIL)" \
	  --user-pool-id "$$($(TF) output -raw user_pool_id)"

destroy: ## Destroy the stack (empty the buckets first)
	$(TF) init -input=false -reconfigure -backend-config=backend/$(CONFIG).s3.tfbackend >/dev/null
	$(TF) destroy -var-file=$(CONFIG).tfvars
