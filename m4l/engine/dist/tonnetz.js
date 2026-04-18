"use strict";
// Tonnetz engine for Oedipa.
// Spec: docs/ai/adr/001-tonnetz-engine-interface.md
//
// Compiled to CommonJS (see tsconfig.json) and consumed in two environments:
// - Node.js tests via `node --test` (types stripped at runtime)
// - Max for Live jsui via dist/tonnetz.js (small prelude in the jsui script
//   provides a `module`/`exports` shim)
Object.defineProperty(exports, "__esModule", { value: true });
exports.identifyTriad = identifyTriad;
exports.buildTriad = buildTriad;
exports.applyTransform = applyTransform;
exports.applyVoicing = applyVoicing;
exports.addSeventh = addSeventh;
exports.walk = walk;
function mod12(n) {
    return ((n % 12) + 12) % 12;
}
function identifyTriad(triad) {
    const pcs = triad.map(mod12);
    for (const pc of pcs) {
        const ints = pcs.map(p => mod12(p - pc)).sort((a, b) => a - b);
        if (ints[0] === 0 && ints[1] === 4 && ints[2] === 7) {
            return { rootPc: pc, quality: 'major' };
        }
        if (ints[0] === 0 && ints[1] === 3 && ints[2] === 7) {
            return { rootPc: pc, quality: 'minor' };
        }
    }
    throw new Error('identifyTriad: input is not a major or minor triad');
}
function buildTriad(rootPc, quality, reference) {
    let root = Math.floor(reference / 12) * 12 + rootPc;
    if (root - reference > 6)
        root -= 12;
    if (reference - root > 6)
        root += 12;
    while (root < 36)
        root += 12;
    while (root > 84)
        root -= 12;
    const third = root + (quality === 'minor' ? 3 : 4);
    const fifth = root + 7;
    return [root, third, fifth];
}
function applyTransform(triad, op) {
    const { rootPc, quality } = identifyTriad(triad);
    let newRootPc;
    const newQuality = quality === 'major' ? 'minor' : 'major';
    if (op === 'P') {
        newRootPc = rootPc;
    }
    else if (op === 'L') {
        newRootPc = quality === 'major' ? mod12(rootPc + 4) : mod12(rootPc + 8);
    }
    else if (op === 'R') {
        newRootPc = quality === 'major' ? mod12(rootPc + 9) : mod12(rootPc + 3);
    }
    else {
        const _exhaustive = op;
        throw new Error('applyTransform: unknown op ' + _exhaustive);
    }
    return buildTriad(newRootPc, newQuality, triad[0]);
}
function applyVoicing(triad, mode) {
    const [a, b, c] = triad;
    if (mode === 'close')
        return [a, b, c];
    if (mode === 'spread')
        return [a, b + 12, c];
    if (mode === 'drop2')
        return [a, c, b + 12];
    const _exhaustive = mode;
    throw new Error('applyVoicing: unknown mode ' + _exhaustive);
}
function addSeventh(voiced, triad) {
    const isMajor = mod12(triad[1] - triad[0]) === 4;
    const seventh = triad[0] + (isMajor ? 11 : 10);
    return voiced.concat([seventh]);
}
function walk(state, pos) {
    var _a;
    const spt = state.stepsPerTransform;
    const seq = state.sequence;
    const anchors = (_a = state.anchors) !== null && _a !== void 0 ? _a : [];
    const anchorAt = {};
    for (const a of anchors) {
        anchorAt[a.step] = a.triad;
    }
    let chord = [state.startChord[0], state.startChord[1], state.startChord[2]];
    let applied = 0;
    for (let step = 0; step <= pos; step++) {
        const anchor = anchorAt[step];
        if (anchor !== undefined) {
            chord = [anchor[0], anchor[1], anchor[2]];
            applied = 0;
        }
        else if (step > 0 && step % spt === 0) {
            const op = seq[applied % seq.length];
            chord = applyTransform(chord, op);
            applied += 1;
        }
    }
    return chord;
}
