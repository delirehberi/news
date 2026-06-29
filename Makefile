.PHONY: setup init push-secrets worker-init db-init db-apply-local db-apply-remote vectorize-init dev-worker dev-frontend frontend-build deploy-worker deploy-frontend deploy

NVM_CMD=. ~/.nvm/nvm.sh && nvm use &&

setup:
	@echo "Setting up Node environment and installing global dependencies..."
	bash -c '$(NVM_CMD) npm install -g wrangler'

init:
	@echo "Initializing project for local development..."
	bash -c '$(NVM_CMD) cd worker && npm install'
	bash -c '$(NVM_CMD) cd frontend && npm install'
	@echo "--------------------------------------------------------"
	@echo "✅ Dependencies installed!"
	@echo "Next steps for new developers:"
	@echo "1. Run 'make db-init' to create your Cloudflare D1 database."
	@echo "2. Run 'make vectorize-init' to create your Vectorize index."
	@echo "3. Update 'worker/wrangler.jsonc' with the new IDs generated from steps 1 & 2."
	@echo "4. Export your secrets to your terminal (or use .envrc), then run 'make push-secrets'."
	@echo "5. Run 'make db-apply-remote' to build the DB tables."
	@echo "--------------------------------------------------------"

push-secrets:
	@echo "Pushing secrets from local environment variables to Cloudflare..."
	bash -c '$(NVM_CMD) cd worker && echo "$$REDDIT_CLIENT_ID" | npx wrangler secret put REDDIT_CLIENT_ID'
	bash -c '$(NVM_CMD) cd worker && echo "$$REDDIT_CLIENT_SECRET" | npx wrangler secret put REDDIT_CLIENT_SECRET'
	bash -c '$(NVM_CMD) cd worker && echo "$$REDDIT_REFRESH_TOKEN" | npx wrangler secret put REDDIT_REFRESH_TOKEN'
	bash -c '$(NVM_CMD) cd worker && echo "$$AUTHORIZED_NOSTR_PUBKEY" | npx wrangler secret put AUTHORIZED_NOSTR_PUBKEY'
	@echo "Secrets pushed successfully!"

worker-init:
	@echo "Initializing Cloudflare Worker with Hono..."
	bash -c '$(NVM_CMD) npm create hono@latest worker -- --template cloudflare-workers --install'

db-init:
	@echo "Creating D1 database..."
	bash -c '$(NVM_CMD) cd worker && npx wrangler d1 create news-db'

db-apply-local:
	@echo "Applying schema to local D1 database..."
	bash -c '$(NVM_CMD) cd worker && npx wrangler d1 execute news-db --local --file=../schema.sql'

db-apply-remote:
	@echo "Applying schema to remote D1 database..."
	bash -c '$(NVM_CMD) cd worker && npx wrangler d1 execute news-db --remote --file=../schema.sql'

vectorize-init:
	@echo "Creating Vectorize index..."
	bash -c '$(NVM_CMD) cd worker && npx wrangler vectorize create news-index --dimensions=768 --metric=cosine'

dev-worker:
	@echo "Starting Worker in development mode..."
	bash -c '$(NVM_CMD) cd worker && npx wrangler dev --remote'

dev-frontend:
	@echo "Starting Frontend in development mode..."
	bash -c '$(NVM_CMD) cd frontend && npx vite'

frontend-build:
	@echo "Building Frontend for production..."
	bash -c '$(NVM_CMD) cd frontend && npx vite build'

deploy-worker:
	@echo "Deploying Worker to Cloudflare..."
	bash -c '$(NVM_CMD) cd worker && npx wrangler deploy'

deploy-frontend: frontend-build
	@echo "Deploying Frontend to Cloudflare Pages..."
	bash -c '$(NVM_CMD) cd frontend && npx wrangler pages deploy dist --project-name news-frontend'

deploy: deploy-worker deploy-frontend
	@echo "Successfully deployed both Backend and Frontend!"
