# Cross-target distribution orchestrator. Per-target build / test commands
# live in `m4l/` (pnpm workspace) and `vst/Makefile`. This root Makefile
# only chains release flows for distribution.

.PHONY: release release-m4l release-vst

release: release-m4l release-vst

release-m4l:
	cd m4l && pnpm -r build && pnpm bake
	mkdir -p dist
	@echo ""
	@echo "Next (m4l): open m4l/Oedipa.amxd in Max → click the snowflake"
	@echo "            (Freeze) button in the patcher toolbar → File → Save As"
	@echo "            $(CURDIR)/dist/Oedipa.amxd"

# Requires DEVELOPER_TEAM_ID env var (Apple Developer team identifier);
# notary keychain profile defaults to oedipa-notary, override with
# NOTARY_PROFILE.
release-vst:
	cd vst && $(MAKE) build
	cd vst && ./scripts/codesign.sh
	cd vst && ./scripts/notarize.sh
	cd vst && ./scripts/build-dmg.sh
