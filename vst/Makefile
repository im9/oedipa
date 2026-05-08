.PHONY: build debug clean open kill test

build:
	cmake -B build -DCMAKE_BUILD_TYPE=Release
	cmake --build build --config Release -j8

debug:
	cmake -B build -DCMAKE_BUILD_TYPE=Debug
	cmake --build build --config Debug -j8

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
