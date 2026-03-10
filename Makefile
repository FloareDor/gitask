.PHONY: install dev build start clean

install:
	npm install

dev:
	npm run dev

build:
	npm run build

start: build
	npm run start

clean:
	rm -rf .next node_modules
