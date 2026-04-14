app:
	./scripts/build-app.sh

release:
	./scripts/build-app.sh "$(VERSION)" --notarize --dmg

dev:
	bun run tauri dev

clean:
	rm -rf dist/ src-tauri/target/

.PHONY: app release dev clean
