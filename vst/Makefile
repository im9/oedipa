.PHONY: build debug clean open kill test verify-artefacts

build:
	cmake -B build -DCMAKE_BUILD_TYPE=Release
	cmake --build build --config Release -j8
	./scripts/check-artefacts.sh build Release

debug:
	cmake -B build -DCMAKE_BUILD_TYPE=Debug
	cmake --build build --config Debug -j8

verify-artefacts:
	./scripts/check-artefacts.sh build Release

test:
	cmake -B build -DCMAKE_BUILD_TYPE=Release
	cmake --build build --target oedipa_tests -j8
	./build/oedipa_tests

clean:
	rm -rf build

open:
	open build/Oedipa_artefacts/Release/Standalone/Oedipa.app

kill:
	@pkill -x Oedipa 2>/dev/null || true
