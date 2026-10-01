.PHONY: setup init push-secrets worker-init db-init db-migrate db-migrate-local db-migrate-list db-migrate-create vectorize-init dev-worker dev-frontend frontend-build deploy-worker deploy

NVM_CMD=. ~/.nvm/nvm.sh && nvm use &&

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

