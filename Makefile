.PHONY: install build start clean lint test docker-build docker-run docker-compose docker-down

install:
	npm install

build:
	npm run build

start:
	npm start

dev:
	npm run dev

clean:
	rm -rf dist
	rm -rf node_modules

lint:
	npm run lint

test:
	npm run test

docker-build:
	docker build -t mcp-sumologic .

docker-run:
	docker run --rm --env-file .env -p 3006:3006 mcp-sumologic

docker-compose:
	docker-compose up --build -d

docker-down:
	docker-compose down
