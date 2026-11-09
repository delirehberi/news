# Re-clustering judges hundreds of candidate pairs with the LLM, so it can take several minutes.
RECLUSTER_ENDPOINT ?= https://news.emre.xyz/api/admin/recluster
RECLUSTER_TIMEOUT_SECONDS ?= 900

.PHONY: recluster recluster-dry test typecheck types setup init push-secrets worker-init db-init db-migrate db-migrate-local db-migrate-list db-migrate-create vectorize-init dev-worker dev-frontend frontend-build deploy-worker deploy video-init video-test video-typecheck video-draft video-capture video-approve video-produce video-auth

NVM_CMD=. ~/.nvm/nvm.sh && nvm use &&

.PHONY: prepare approve cron-install weekly-check

WEEKLY_GOALS := prepare approve video-draft video-capture video-approve video-produce shorts-draft shorts-produce
VALID_ISO_WEEKS := W01 W02 W03 W04 W05 W06 W07 W08 W09 \
  W10 W11 W12 W13 W14 W15 W16 W17 W18 W19 \
  W20 W21 W22 W23 W24 W25 W26 W27 W28 W29 \
  W30 W31 W32 W33 W34 W35 W36 W37 W38 W39 \
  W40 W41 W42 W43 W44 W45 W46 W47 W48 W49 \
  W50 W51 W52 W53
WEEK_TRIMMED := $(strip $(value WEEK))
ifneq ($(filter $(WEEKLY_GOALS),$(MAKECMDGOALS)),)
EXTRA_WEEKLY_GOALS := $(filter-out $(WEEKLY_GOALS),$(MAKECMDGOALS))
ifneq ($(EXTRA_WEEKLY_GOALS),)
$(error Unexpected positional argument(s) "$(EXTRA_WEEKLY_GOALS)". Pass the target ISO week with WEEK=YYYY-Www (e.g. make $(firstword $(filter $(WEEKLY_GOALS),$(MAKECMDGOALS))) WEEK=2026-W44))
endif
ifneq ($(WEEK_TRIMMED),)
WEEK_PARTS := $(subst -, ,$(WEEK_TRIMMED))
WEEK_YEAR_DIGITS := $(strip $(subst 0,,$(subst 1,,$(subst 2,,$(subst 3,,$(subst 4,,$(subst 5,,$(subst 6,,$(subst 7,,$(subst 8,,$(subst 9,,$(word 1,$(WEEK_PARTS)))))))))))))
ifneq ($(words $(value WEEK))|$(words $(WEEK_PARTS))|$(WEEK_YEAR_DIGITS)|$(words $(subst 0,0 ,$(subst 1,1 ,$(subst 2,2 ,$(subst 3,3 ,$(subst 4,4 ,$(subst 5,5 ,$(subst 6,6 ,$(subst 7,7 ,$(subst 8,8 ,$(subst 9,9 ,$(word 1,$(WEEK_PARTS)))))))))))))|$(filter $(word 2,$(WEEK_PARTS)),$(VALID_ISO_WEEKS))|$(word 1,$(WEEK_PARTS))-$(word 2,$(WEEK_PARTS)),1|2||4|$(word 2,$(WEEK_PARTS))|$(WEEK_TRIMMED))
$(error Invalid WEEK="$(value WEEK)". Expected WEEK=YYYY-Www (e.g. WEEK=2026-W44))
endif
endif
endif

WEEK_FLAG = $(if $(WEEK_TRIMMED),--week $(WEEK_TRIMMED),)

prepare:
	bash scripts/weekly.sh prepare $(WEEK_TRIMMED)

approve:
	bash scripts/weekly.sh approve $(WEEK_TRIMMED)

cron-install:
	bash scripts/weekly-cron.sh

weekly-check:
	bash -n scripts/weekly.sh
	bash -n scripts/weekly-cron.sh
	bash -c '$(NVM_CMD) cd video && npx vitest run src/weekly-job.test.ts'

setup:
	@echo "Setting up Node environment and installing global dependencies..."
	bash -c '$(NVM_CMD) npm install -g wrangler'

init:
	@echo "Initializing project for local development..."
	bash -c '$(NVM_CMD) cd worker && npm install'
	bash -c '$(NVM_CMD) cd frontend && npm install'
	@echo "Creating configuration files from templates..."
	@if [ ! -f worker/wrangler.jsonc ]; then cp worker/wrangler.example.jsonc worker/wrangler.jsonc; echo "Created worker/wrangler.jsonc"; fi
	@if [ ! -f frontend/.env ]; then cp frontend/.env.example frontend/.env; echo "Created frontend/.env"; fi
	@echo "--------------------------------------------------------"
	@echo "✅ Dependencies installed and config templates created!"
	@echo "Next steps for new developers:"
	@echo "1. Run 'make db-init' to create your Cloudflare D1 database."
	@echo "2. Run 'make vectorize-init' to create your Vectorize index."
	@echo "3. Update 'worker/wrangler.jsonc' with the new IDs generated from steps 1 & 2."
	@echo "4. Export your secrets to your terminal (or use .envrc), then run 'make push-secrets'."
	@echo "5. Run 'make db-migrate' to apply database migrations."
	@echo "--------------------------------------------------------"

push-secrets:
	@echo "Pushing secrets from local environment variables to Cloudflare..."
	bash -c '$(NVM_CMD) cd worker && echo "$$REDDIT_CLIENT_ID" | npx wrangler secret put REDDIT_CLIENT_ID'
	bash -c '$(NVM_CMD) cd worker && echo "$$REDDIT_CLIENT_SECRET" | npx wrangler secret put REDDIT_CLIENT_SECRET'
	bash -c '$(NVM_CMD) cd worker && echo "$$REDDIT_REFRESH_TOKEN" | npx wrangler secret put REDDIT_REFRESH_TOKEN'
	bash -c '$(NVM_CMD) cd worker && echo "$$GMAIL_CLIENT_ID" | npx wrangler secret put GMAIL_CLIENT_ID'
	bash -c '$(NVM_CMD) cd worker && echo "$$GMAIL_CLIENT_SECRET" | npx wrangler secret put GMAIL_CLIENT_SECRET'
	bash -c '$(NVM_CMD) cd worker && echo "$$GMAIL_REFRESH_TOKEN" | npx wrangler secret put GMAIL_REFRESH_TOKEN'
	bash -c '$(NVM_CMD) cd worker && echo "$$AUTHORIZED_NOSTR_PUBKEY" | npx wrangler secret put AUTHORIZED_NOSTR_PUBKEY'
	@if [ -n "$$INGESTION_SECRET" ]; then \
		bash -c '$(NVM_CMD) cd worker && echo "$$INGESTION_SECRET" | npx wrangler secret put INGESTION_SECRET'; \
	fi
	@echo "Secrets pushed successfully!"

worker-init:
	@echo "Initializing Cloudflare Worker with Hono..."
	bash -c '$(NVM_CMD) npm create hono@latest worker -- --template cloudflare-workers --install'

db-init:
	@echo "Creating D1 database..."
	bash -c '$(NVM_CMD) cd worker && npx wrangler d1 create news-db'

db-migrate:
	@echo "Applying pending migrations to remote D1 database..."
	bash -c '$(NVM_CMD) cd worker && npx wrangler d1 migrations apply news-db --remote'

db-migrate-local:
	@echo "Applying pending migrations to local D1 database..."
	bash -c '$(NVM_CMD) cd worker && npx wrangler d1 migrations apply news-db --local'

db-migrate-list:
	@echo "Listing remote D1 migrations status..."
	bash -c '$(NVM_CMD) cd worker && npx wrangler d1 migrations list news-db --remote'

db-migrate-create:
	@echo "Creating a new migration..."
	@read -p "Enter migration name: " name; \
	bash -c '$(NVM_CMD) cd worker && npx wrangler d1 migrations create news-db $$name'

vectorize-init:
	@echo "Creating Vectorize index..."
	bash -c '$(NVM_CMD) cd worker && npx wrangler vectorize create news-index --dimensions=768 --metric=cosine'

dev-worker: frontend-build
	@echo "Starting Worker in development mode..."
	bash -c '$(NVM_CMD) cd worker && npx wrangler dev --remote'

dev-frontend:
	@echo "Starting Frontend in development mode..."
	bash -c '$(NVM_CMD) cd frontend && npx vite'

frontend-build:
	@echo "Building Frontend for production into worker/public..."
	bash -c '$(NVM_CMD) cd frontend && npx vite build'

deploy-worker: frontend-build
	@echo "Deploying Unified SSR Worker to Cloudflare..."
	bash -c '$(NVM_CMD) cd worker && npx wrangler deploy'

deploy: deploy-worker
	@echo "Successfully deployed Unified SSR Worker to Cloudflare!"

ingest:
	@echo "Triggering manual news ingestion..."
	@if [ -n "$$INGESTION_SECRET" ]; then \
		curl -s -H "Authorization: Bearer $$INGESTION_SECRET" "https://news.emre.xyz/api/admin/ingest" | jq .; \
	else \
		curl -s "http://localhost:8787/api/admin/ingest" | jq . || curl -s "https://news.emre.xyz/api/admin/ingest" | jq .; \
	fi

recluster-dry:
	@echo "Previewing duplicate re-clustering of live articles (no writes)..."
	@if [ -z "$$INGESTION_SECRET" ]; then echo "INGESTION_SECRET must be set"; exit 1; fi
	@curl -sS --fail-with-body --max-time $(RECLUSTER_TIMEOUT_SECONDS) -X POST -H "Authorization: Bearer $$INGESTION_SECRET" "$(RECLUSTER_ENDPOINT)?dryRun=1" | jq .

recluster:
	@echo "Re-clustering live articles and rewriting cluster_id/sources..."
	@if [ -z "$$INGESTION_SECRET" ]; then echo "INGESTION_SECRET must be set"; exit 1; fi
	@curl -sS --fail-with-body --max-time $(RECLUSTER_TIMEOUT_SECONDS) -X POST -H "Authorization: Bearer $$INGESTION_SECRET" "$(RECLUSTER_ENDPOINT)" | jq .

types:
	@echo "Regenerating Worker binding types from wrangler.jsonc..."
	bash -c '$(NVM_CMD) cd worker && npx wrangler types'

typecheck:
	@echo "Type-checking the Worker..."
	bash -c '$(NVM_CMD) cd worker && npx tsc --noEmit'

test:
	@echo "Running Worker unit tests..."
	bash -c '$(NVM_CMD) cd worker && npx vitest run'

video-init:
	@echo "Installing Weekly Video CLI dependencies..."
	bash -c '$(NVM_CMD) cd video && npm install'
	@if [ ! -f video/.env ]; then cp video/.env.example video/.env; echo "Created video/.env from template"; fi
	@chmod +x video/src/cli.ts video/cli.ts

video-typecheck:
	@echo "Type-checking Weekly Video CLI..."
	bash -c '$(NVM_CMD) cd video && npx tsc --noEmit'

video-test:
	@echo "Running Weekly Video CLI unit tests..."
	bash -c '$(NVM_CMD) cd video && npx vitest run'

video-draft:
	@echo "Running weekly video draft pipeline (select -> translate -> capture -> script)..."
	bash -c '$(NVM_CMD) cd video && node --experimental-strip-types src/cli.ts select $(WEEK_FLAG)'
	bash -c '$(NVM_CMD) cd video && node --experimental-strip-types src/cli.ts translate $(WEEK_FLAG)'
	bash -c '$(NVM_CMD) cd video && node --experimental-strip-types src/cli.ts capture $(WEEK_FLAG)'
	bash -c '$(NVM_CMD) cd video && node --experimental-strip-types src/cli.ts script $(WEEK_FLAG)'

video-capture:
	@echo "Capturing full-page screenshots and element maps for weekly stories..."
	bash -c '$(NVM_CMD) cd video && node --experimental-strip-types src/cli.ts capture $(WEEK_FLAG)'

video-approve:
	@echo "Approving weekly video script and publishing Turkish web edition..."
	bash -c '$(NVM_CMD) cd video && node --experimental-strip-types src/cli.ts approve $(WEEK_FLAG)'

video-produce:
	@echo "Running weekly video production pipeline (voice -> capture -> render -> upload)..."
	bash -c '$(NVM_CMD) cd video && node --experimental-strip-types src/cli.ts voice $(WEEK_FLAG)'
	bash -c '$(NVM_CMD) cd video && node --experimental-strip-types src/cli.ts capture $(WEEK_FLAG)'
	bash -c '$(NVM_CMD) cd video && node --experimental-strip-types src/cli.ts render $(WEEK_FLAG)'
	bash -c '$(NVM_CMD) cd video && node --experimental-strip-types src/cli.ts upload $(WEEK_FLAG)'

video-auth:
	@echo "Running YouTube OAuth2 PKCE loopback flow..."
	bash -c '$(NVM_CMD) cd video && node --experimental-strip-types src/cli.ts auth'

.PHONY: shorts-draft shorts-produce shorts-music
# MOCK=1 explicitly generates silent verification audio; regenerate without it before posting.
SHORTS_FLAGS = $(WEEK_FLAG) $(if $(filter 1,$(MOCK)),--mock,)
shorts-draft:
	bash -c '$(NVM_CMD) cd video && node --experimental-strip-types src/cli.ts shorts-script $(SHORTS_FLAGS)'

shorts-produce:
	bash -c '$(NVM_CMD) cd video && node --experimental-strip-types src/cli.ts shorts-voice $(SHORTS_FLAGS)'
	bash -c '$(NVM_CMD) cd video && node --experimental-strip-types src/cli.ts shorts-capture $(SHORTS_FLAGS)'
	bash -c '$(NVM_CMD) cd video && node --experimental-strip-types src/cli.ts shorts-render $(SHORTS_FLAGS)'
	bash -c '$(NVM_CMD) cd video && node --experimental-strip-types src/cli.ts shorts-posting $(SHORTS_FLAGS)'

# Regenerates the royalty-free background bed (ffmpeg only) used under shorts narration.
shorts-music:
	bash video/scripts/generate-music.sh video/assets/music/bed.mp3
