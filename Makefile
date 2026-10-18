.PHONY: dev test check

dev:
	node src/main.ts

test:
	node --test tests/

check:
	npx tsc --noEmit
