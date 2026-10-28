/**
 * Regression test for the "Different document picking in progress" crash.
 *
 * Runs in plain Node with stubbed native modules — no device or Expo runtime
 * needed. It transpiles src/scripts/documentPicker.ts on the fly and shortens
 * the watchdog timers so the lifecycle cases run in milliseconds.
 *
 *   node tests/documentPicker.test.cjs
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const ts = require("typescript");

const SOURCE = path.resolve(__dirname, "../src/scripts/documentPicker.ts");

let src = fs.readFileSync(SOURCE, "utf8");
src = src
  .replace(/const RESUME_GRACE_MS = [\d_]+;/, "const RESUME_GRACE_MS = 40;")
  .replace(/const HARD_TIMEOUT_MS = [^;]+;/, "const HARD_TIMEOUT_MS = 300;");

const js = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText;

// ---- controllable native stubs -------------------------------------------
let nativeCalls = 0;
let pendingResolve = null;
let behavior = "resolve";
let appHandlers = [];
let resetCalls = 0;

const OK = {
  canceled: false,
  assets: [{ uri: "file:///x.wav", name: "x.wav" }],
};
const CANCELED = { canceled: true, assets: null };
const IN_PROGRESS =
  "Different document picking in progress. Await other document picking first.";

function defaultGetDocumentAsync() {
  nativeCalls++;
  if (behavior === "throw") return Promise.reject(new Error(IN_PROGRESS));
  if (behavior === "hang") {
    return new Promise((resolve) => {
      pendingResolve = resolve;
    });
  }
  return Promise.resolve(OK);
}

const documentPickerStub = {
  getDocumentAsync: defaultGetDocumentAsync,
};

const stubs = {
  "expo-document-picker": documentPickerStub,
  "expo-modules-core": {
    requireNativeModule: () => ({
      cancelPendingPick: () => {
        resetCalls++;
        if (pendingResolve) {
          pendingResolve(CANCELED);
          pendingResolve = null;
        }
        return Promise.resolve();
      },
    }),
  },
  "react-native": {
    AppState: {
      addEventListener: (_type, handler) => {
        appHandlers.push(handler);
        return {
          remove: () => {
            appHandlers = appHandlers.filter((h) => h !== handler);
          },
        };
      },
    },
  },
};

const originalLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  // eslint-disable-next-line prefer-rest-params
  return originalLoad.apply(this, arguments);
};
const testModule = new Module(path.resolve(__dirname, "wrapper.cjs"), module);
testModule.filename = path.resolve(__dirname, "wrapper.cjs");
testModule.paths = Module._nodeModulePaths(__dirname);
testModule._compile(js, testModule.filename);
Module._load = originalLoad;

const { pickDocument, isDocumentPickerBusy } = testModule.exports;

// ---- helpers --------------------------------------------------------------
const emitAppState = (state) => appHandlers.slice().forEach((h) => h(state));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const opts = { type: ["audio/*"] };
let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function reset(behaviorName = "resolve") {
  behavior = behaviorName;
  nativeCalls = 0;
  resetCalls = 0;
  pendingResolve = null;
  documentPickerStub.getDocumentAsync = defaultGetDocumentAsync;
}

async function run() {
  console.log("\n[A] normal successful pick");
  reset("resolve");
  let r = await pickDocument(opts);
  check("returns assets", r.canceled === false && r.assets.length === 1);
  check("lock released", isDocumentPickerBusy() === false);

  console.log("\n[B] double tap while the picker is open");
  reset("hang");
  const first = pickDocument(opts);
  const second = await pickDocument(opts);
  check("second tap ignored as canceled", second.canceled === true);
  check("native picker launched exactly once", nativeCalls === 1, `calls=${nativeCalls}`);
  emitAppState("background");
  emitAppState("active");
  await first;

  console.log("\n[C] lost activity result (Android Back) — watchdog recovers");
  reset("hang");
  const stuck = pickDocument(opts);
  emitAppState("background");
  emitAppState("active");
  const recovered = await stuck;
  check("settles as canceled", recovered.canceled === true, JSON.stringify(recovered));
  check("native reset invoked once", resetCalls === 1, `resetCalls=${resetCalls}`);
  check("lock released", isDocumentPickerBusy() === false);
  behavior = "resolve";
  const after = await pickDocument(opts);
  check("next pick works", after.canceled === false && after.assets.length === 1);

  console.log("\n[D] module already wedged — auto reset and retry once");
  reset("throw");
  let calls = 0;
  documentPickerStub.getDocumentAsync = () => {
    calls++;
    return calls === 1
      ? Promise.reject(new Error(IN_PROGRESS))
      : Promise.resolve(OK);
  };
  const retried = await pickDocument(opts);
  check("retry succeeded", retried.canceled === false && retried.assets.length === 1);
  check("exactly two native calls", calls === 2, `calls=${calls}`);
  check("reset invoked", resetCalls === 1, `resetCalls=${resetCalls}`);
  check("lock released", isDocumentPickerBusy() === false);

  console.log("\n[E] resumed-but-unsettled pick, then the user taps again");
  reset("hang");
  const p1 = pickDocument(opts);
  emitAppState("background");
  emitAppState("active");
  await wait(5); // resumed flag set, watchdog has not fired yet
  documentPickerStub.getDocumentAsync = () => Promise.resolve(OK);
  const p2 = await pickDocument(opts);
  check("fresh pick returns assets", p2.canceled === false && p2.assets.length === 1);
  check("old pick settled as canceled", (await p1).canceled === true);
  check("lock released", isDocumentPickerBusy() === false);

  console.log("\n[F] non-picker errors propagate unchanged");
  reset("resolve");
  const boom = new Error("disk full");
  documentPickerStub.getDocumentAsync = () => Promise.reject(boom);
  let caught = null;
  try {
    await pickDocument(opts);
  } catch (e) {
    caught = e;
  }
  check("original error rethrown", caught === boom);
  check("lock released after error", isDocumentPickerBusy() === false);

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error("HARNESS ERROR", e);
  process.exit(2);
});
