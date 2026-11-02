# AgentChannel build entry points.

.PHONY: deps build run

deps:
	cd hub && test -x bin/pocketbase || ./scripts/fetch-pocketbase.sh
	cd packages/agentchannel && npm ci

build:
	cd packages/agentchannel && npm run build

run:
	cd hub && ./bin/pocketbase serve --dir pb_data --hooksDir pb_hooks \
	  --migrationsDir pb_migrations --publicDir pb_public --http 127.0.0.1:8090
