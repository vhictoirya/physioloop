# PhysioLoop × QVAC — Friction Log

Honest notes from integrating `@qvac/sdk` + `react-native-bare-kit` into a production Expo app during the Colosseum Frontier hackathon (May 2026). Written for the Tether QVAC side-track submission.

---

## What we built

PhysioLoop uses QVAC to run **SmolVLM2-500M-MultiModal-Q8_0** entirely on the patient's phone. The model receives a camera frame and outputs a JSON attestation confirming whether the patient is performing the prescribed exercise. A SHA-256 hash of a 3-frame attestation bundle is submitted to an Anchor program on Solana. No exercise image ever leaves the device.

The integration stack:
- `@qvac/sdk` — model loading, inference, IPC
- `react-native-bare-kit` — isolated Bare JS worklet in React Native
- `bare-pack` — bundles the worklet from ES modules to a single `.bundle` file
- `expo-camera` — captures frames during the exercise
- `expo-file-system` — copies frames to `documentDirectory` for the bare runtime

---

## Friction encountered

### 1. `bare-pack` fails silently on `require('crypto')` inside `@qvac/sdk`

**What happened:** Running `bare-pack ./index.js -o ../assets/qvac-worker.bundle` produced a bundle but at runtime the worklet crashed immediately with `MODULE_NOT_FOUND: crypto`.

**Root cause:** `@qvac/rag/HyperDBAdapter.js` contains:
```js
try {
  crypto = require('crypto')   // Node.js built-in
} catch {
  crypto = require('bare-crypto')  // Bare built-in fallback
}
```
`bare-pack`'s static analyser sees both `require('crypto')` and `require('bare-crypto')`. It tries to bundle `crypto` as a user module, can't find it, and emits an empty shim — but doesn't error. At runtime the shim throws.

**Fix:** Create `builtins.json`:
```json
["crypto"]
```
Then pass `--builtins ./builtins.json` to bare-pack:
```json
"bundle": "bare-pack ./index.js --builtins ./builtins.json -o ../assets/qvac-worker.bundle"
```
This tells bare-pack to treat `crypto` as an external built-in. The `require('crypto')` try-block throws at runtime (Bare has no Node `crypto` built-in), the catch fires, and `require('bare-crypto')` succeeds.

**Suggestion for QVAC team:** Document `builtins.json` in the bare-pack integration guide. The silent failure mode (no build error, crash at runtime) wasted significant time. A warning when a Node.js built-in is detected without a corresponding `builtins.json` entry would catch this immediately.

---

### 2. `bare-ipc` not listed in `@qvac/sdk` peer dependencies

**What happened:** `bare-pack` errored with `MODULE_NOT_FOUND: bare-ipc` during bundling, even though `bare-ipc` is imported by the worklet.

**Root cause:** `bare-ipc` is a transitive dependency of `@qvac/sdk` but is not declared as a peer dependency or auto-installed. In a fresh worklet directory with only `@qvac/sdk` in `package.json`, `bare-ipc` is not installed.

**Fix:** Add `bare-ipc` explicitly to the worklet's `package.json`:
```json
"dependencies": {
  "@qvac/sdk": "latest",
  "b4a": "^1.6.6",
  "bare-ipc": "latest"
}
```

**Suggestion for QVAC team:** Either declare `bare-ipc` as a peer dependency of `@qvac/sdk`, or include it as a direct dependency. The error message `MODULE_NOT_FOUND: bare-ipc` is not immediately obvious as a missing peer — it looks like a user error.

---

### 3. The worklet `npm install` must be run with `--prefix .` in the worklet directory

**What happened:** Running `npm install` from the patient-app root (or without `cd worklet`) did not create a `node_modules` inside `worklet/`. The bare-pack command then failed because it was resolving modules from the wrong directory.

**Root cause:** Metro and Expo's module resolution intercept installs in non-root `package.json` files differently depending on how npm is invoked.

**Fix:**
```bash
cd worklet && npm install --prefix .
```

**Suggestion:** The getting-started guide should explicitly show `cd worklet && npm install` rather than assuming the user knows that bare-pack resolves modules from the worklet directory's own `node_modules`.

---

### 4. Physical device required — no emulator support

**What happened:** The app builds fine for an Android emulator and iOS simulator but the QVAC worklet throws at startup: `Failed to load native module: react-native-bare-kit`.

**Root cause:** `react-native-bare-kit` links against native C++ libraries (libuv, V8/JavaScriptCore fork) that require a real device ABI. Android emulators running on x86_64 hosts can't execute the arm64 native module.

**Impact:** Every test cycle during development required a physical device or a cloud device farm. USB debugging on Android worked fine; iOS required an Apple Developer account for device provisioning.

**Suggestion for QVAC team:** An x86_64 simulator build of the native module, even if inference is CPU-only and slow, would dramatically improve the development loop. Alternatively, document the device requirement prominently — we spent time troubleshooting before realising emulators are categorically unsupported.

---

### 5. First-run model download blocks UX with no progress feedback from the SDK

**What happened:** On first launch, SmolVLM2-500M + its projection model total ~600 MB. The `loadModel()` call provides an `onProgress` callback, but the download happens before the callback fires reliably — there's a period of 10–20 seconds where the app appears frozen.

**Fix we implemented:** Show a loading screen immediately on `_layout.tsx` boot, subscribe to all worklet IPC messages including `{ type: 'status', phase: 'loading_vision', percentage: N }` that we emit from the worklet, and render a progress bar to the patient.

```ts
qvacBridge.onMessage((msg) => {
  if (msg.type === 'status' && msg.phase === 'loading_vision') {
    setDownloadPct(msg.percentage ?? 0)
  }
})
```

**Suggestion:** The SDK's `onProgress` callback fires during model loading (after download), but the download phase itself has inconsistent reporting. Consistent `onProgress` from the moment the network fetch begins would let apps show accurate progress without IPC workarounds.

---

### 6. No documentation on how `imagePath` must be formatted for the Bare runtime

**What happened:** We passed the URI from `expo-camera` (`file:///data/user/0/...`) directly to the worklet. Bare's file APIs expect a POSIX path without the `file://` prefix. The worklet silently returned a null attestation.

**Fix:**
```ts
// expo-camera returns file:// URI — bare runtime needs raw POSIX path
const framePath = `${FileSystem.documentDirectory}physioloop_frame_${i}.jpg`
await FileSystem.copyAsync({ from: photo.uri, to: framePath })
// Strip file:// prefix before passing to worklet
const posixPath = framePath.replace('file://', '')
qvacBridge.analyzeExercise(posixPath, exerciseName)
```

**Suggestion:** Document that `imagePath` must be a POSIX path, not a URI scheme. This is a common source of confusion for Expo developers who are used to working with `file://` URIs everywhere.

---

### 7. Inference time variance makes 3-frame UX tricky on lower-end devices

**What happened:** On a mid-range Android device (Snapdragon 720G), each frame takes 18–25 seconds to infer. With 3 frames and 3-second countdowns between them, total verification time approaches 90 seconds. This is at the edge of acceptable UX for a physiotherapy exercise session.

**What we did:** We set GPU offload to 99 layers (`gpu_layers: 99`) and lowered `temp` to 0.1 for deterministic short output (`predict: 256`). This is already close to optimal for the given model size.

**Suggestion:** The QVAC roadmap mentions a smaller ~150M parameter model. Even if it's less accurate, a configurable model size trade-off (accuracy vs latency) would help consumer apps on mid-range hardware. For adherence verification (not clinical diagnosis), 0.75 confidence from a faster model is more useful than 0.87 confidence after 25 seconds.

---

## What worked well

- **`@qvac/sdk` API is clean.** `loadModel` + `completion` + `unloadModel` is intuitive. The streaming token output via `result.tokenStream` made it easy to show the model "thinking" in real time.
- **Model stays in memory across reps.** Once loaded, `visionModelId` persists in the worklet and subsequent inference calls are instant (no reload). This is essential for a multi-rep session.
- **GPU acceleration just works on iOS.** Metal offload required zero configuration beyond `device: 'gpu'`. First-run load time is 8–12 seconds on a recent iPhone.
- **The privacy story is compelling and true.** We tested with network monitoring (Charles Proxy) and confirmed zero image data leaves the device during inference. This is a genuine differentiator over cloud AI APIs.
- **IPC bridge pattern is reliable.** Sending JSON over `bare-ipc` between the React Native layer and the Bare worklet had no message drops or ordering issues across hundreds of test sessions.

---

## Summary of suggested improvements

| Issue | Priority | Suggested fix |
|---|---|---|
| Silent `crypto` bundling failure | High | Warn when Node.js built-ins appear without `builtins.json` |
| `bare-ipc` not auto-installed | High | Declare as peer dep or direct dep of `@qvac/sdk` |
| No emulator support | Medium | Publish x86_64 CPU-only build for simulators |
| First-run download UX | Medium | Consistent `onProgress` from network fetch start |
| `imagePath` URI vs POSIX | Medium | Document path format requirements |
| Inference latency on mid-range | Low | Expose smaller model option in SDK |
