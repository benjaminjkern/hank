import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import importX from "eslint-plugin-import-x";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import boundaries from "eslint-plugin-boundaries";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// Flat config (ESLint 9). Layered as:
//   1. eslint-config-next        — react-hooks, purity, a11y, TS parser
//   2. type-aware parser         — Next's config does NOT enable type info;
//                                  this block turns it on for our own code so
//                                  the correctness rules below can run
//   3. correctness + hygiene     — the bug-catchers + import discipline
//   4. no-await-in-loop          — the app's single biggest perf rule
//   5. eslint-config-prettier    — LAST, disables every stylistic rule that
//                                  would fight Prettier (Prettier owns format)
//
// Everything Prettier can settle (quotes, indentation, wrapping, trailing
// commas) is Prettier's job — `pnpm format`. ESLint here is correctness +
// import order + architecture only.
const OWN_CODE = ["src/**/*.ts", "src/**/*.tsx", "scripts/**/*.ts"];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  // Type information for our own code. `projectService` is what lets the
  // type-aware rules below (no-floating-promises, no-misused-promises, …) see
  // the TS program; eslint-config-next parses syntactically only.
  {
    files: OWN_CODE,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Correctness + hygiene. Warnings are for things worth seeing but not worth
  // failing CI over (or not always safely auto-fixable); errors are real bugs
  // or fully auto-fixable discipline.
  {
    files: OWN_CODE,
    plugins: { "@typescript-eslint": tseslint.plugin, "import-x": importX },
    settings: {
      "import-x/resolver-next": [
        createTypeScriptImportResolver({
          alwaysTryTypes: true,
          project: "./tsconfig.json",
        }),
      ],
    },
    rules: {
      // --- async correctness (type-aware) ---
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/return-await": ["error", "always"],
      "@typescript-eslint/require-await": "warn",

      // --- general correctness ---
      // allowThrowing{Unknown,Any}: re-throwing an already-caught fault (whose
      // static type is unknown/any) is a deliberate pattern here — e.g.
      // runHankTurn saves the partial then re-throws `turn.errored`.
      "@typescript-eslint/only-throw-error": [
        "error",
        { allowThrowingUnknown: true, allowThrowingAny: true },
      ],
      "@typescript-eslint/no-for-in-array": "error",
      // `any` is allowed (your baseline turns it off); tsc's `strict` already
      // catches the cases that matter, and a few scripts/tests lean on it.
      "@typescript-eslint/no-explicit-any": "off",
      // An empty interface is invalid EXCEPT `interface X extends Y {}`, which
      // is the only way to augment a third-party module's interface (styled.d.ts
      // extends styled-components' DefaultTheme — declaration merging needs an
      // interface, not a type alias).
      "@typescript-eslint/no-empty-object-type": [
        "error",
        { allowInterfaces: "with-single-extends" },
      ],
      // JSX text apostrophes/quotes: cosmetic, warn (matches your baseline).
      "react/no-unescaped-entities": "warn",
      // Pre-existing pattern in several client components; refactoring an effect
      // is behavior-risky, so surface it as a warning to chip away at rather
      // than block. (React Compiler advisory: setState in an effect can cascade
      // a second render.)
      "react-hooks/set-state-in-effect": "warn",
      "array-callback-return": "error",
      "@typescript-eslint/default-param-last": "error",
      // no-unnecessary-type-assertion is deliberately NOT enabled: its autofix
      // removes assertions that only LOOK redundant but are load-bearing for
      // inference — e.g. `{ type: "text", … } as Anthropic.ContentBlockParam`,
      // where dropping the cast widens `type` to `string` and breaks the array's
      // assignability. A rule whose --fix can break the build is not worth the
      // dead-cast cleanup it buys.
      // Off until the tsconfig gains `noUncheckedIndexedAccess`: without it,
      // `arr[i]` is typed as non-undefined, so this rule flags real runtime
      // guards (`if (arr[i]) …`) as unnecessary. ~200 mostly-false positives.
      // Re-enable together with that compiler flag.
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-param-reassign": "warn",
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
      "@typescript-eslint/ban-ts-comment": "warn",

      // --- prefer-safer forms (auto-fixable where possible) ---
      // `ignorePrimitives.boolean` because a `boolean | undefined` is often a
      // deliberate `||` (falsy-OR), not a null-coalesce the rule should push on.
      "@typescript-eslint/prefer-nullish-coalescing": [
        "warn",
        { ignorePrimitives: { boolean: true } },
      ],
      "@typescript-eslint/prefer-optional-chain": "warn",

      // --- import discipline (auto-fixable) ---
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "import-x/order": [
        "warn",
        {
          groups: [
            "builtin",
            "external",
            "internal",
            "parent",
            "sibling",
            "index",
            "object",
            "type",
          ],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
          pathGroups: [{ pattern: "@/**", group: "internal" }],
          pathGroupsExcludedImportTypes: ["builtin"],
        },
      ],
      "import-x/first": "error",
      "import-x/newline-after-import": "warn",
      "import-x/no-duplicates": "warn",
      "import-x/no-useless-path-segments": "warn",
      "import-x/no-self-import": "error",
      // no-cycle intentionally omitted: it walks the whole import graph through
      // the TS resolver (minutes on 500+ files) and the architecture DAG below
      // (eslint-plugin-boundaries) already forbids the back-edges that create
      // cycles. Revisit if a cheap resolver makes it affordable.
    },
  },

  // Scripts run in Node, page through prod rows serially, and log to the
  // console on purpose — the app-code rules that don't fit them are relaxed
  // here rather than disabled globally.
  {
    files: ["scripts/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },

  {
    // The app's single biggest perf rule. `await` inside a loop is N sequential
    // round trips against remote Postgres (~35ms idle) — how a 26-role close
    // blew a 10s transaction budget. Batch instead: findMany / createMany /
    // `$transaction([...])` / Promise.all. Where sequencing is REQUIRED (each
    // step feeds the next; a rate-limited API; a bounded worker draining a
    // queue), disable it on the line with a comment saying which.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: { "no-await-in-loop": "error" },
  },
  {
    // The scraper layer is sequential on purpose, everywhere: paginated boards
    // whose next cursor comes from the previous response, headless scroll/settle
    // steps, provider probes that stop at the first match. (Not exempt: anything
    // touching our own DB — none of that lives here.)
    files: ["src/server/scrape/**/*.ts"],
    rules: { "no-await-in-loop": "off" },
  },

  // Architecture DAG enforcement. AGENTS.md documents a strict one-way layering
  // (tools → procedures → views → entities → platform, with utils/ app-blind and
  // agent/runtime domain-blind) that until now was convention-only. This turns
  // the load-bearing back-edges into lint errors. Denylist model (default:
  // "allow" + targeted "disallow") so we forbid exactly the documented back-edges
  // rather than asserting the full positive graph — that keeps false positives at
  // zero. `agent/contracts` (RunContext / UiEvent / EntryTarget) is a leaf
  // vocabulary imported broadly, so it is never a forbidden target.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    plugins: { boundaries },
    settings: {
      // boundaries resolves `@/…` through the classic resolver settings.
      "import/resolver": {
        typescript: { alwaysTryTypes: true, project: "./tsconfig.json" },
      },
      // First match wins — most specific paths first.
      "boundaries/elements": [
        {
          type: "agent-tools-lib",
          partialMatch: false,
          pattern: "src/server/agent/tools/lib/**",
        },
        {
          type: "agent-tools",
          partialMatch: false,
          pattern: "src/server/agent/tools/**",
        },
        {
          type: "agent-runtime",
          partialMatch: false,
          pattern: "src/server/agent/runtime/**",
        },
        {
          type: "agent-hank",
          partialMatch: false,
          pattern: "src/server/agent/hank/**",
        },
        {
          type: "agent-session",
          partialMatch: false,
          pattern: "src/server/agent/session/**",
        },
        {
          type: "agent-runtree",
          partialMatch: false,
          pattern: "src/server/agent/runTree/**",
        },
        {
          type: "agent-contracts",
          partialMatch: false,
          pattern: "src/server/agent/contracts/**",
        },
        {
          type: "subagents-lib",
          partialMatch: false,
          pattern: "src/server/subagents/lib/**",
        },
        {
          type: "subagents-registry",
          partialMatch: false,
          pattern: "src/server/subagents/registry/**",
        },
        {
          type: "entities",
          partialMatch: false,
          pattern: "src/server/entities/**",
        },
        { type: "views", partialMatch: false, pattern: "src/server/views/**" },
        {
          type: "procedures",
          partialMatch: false,
          pattern: "src/server/procedures/**",
        },
        {
          type: "memory",
          partialMatch: false,
          pattern: "src/server/memory/**",
        },
        {
          type: "scrape",
          partialMatch: false,
          pattern: "src/server/scrape/**",
        },
        {
          type: "widgets",
          partialMatch: false,
          pattern: "src/server/widgets/**",
        },
        {
          type: "platform",
          partialMatch: false,
          pattern: "src/server/platform/**",
        },
        { type: "db", partialMatch: false, pattern: "src/server/db/**" },
        { type: "auth", partialMatch: false, pattern: "src/server/auth/**" },
        { type: "app", partialMatch: false, pattern: "src/app/**" },
        {
          type: "components",
          partialMatch: false,
          pattern: "src/components/**",
        },
        { type: "lib", partialMatch: false, pattern: "src/lib/**" },
        { type: "utils", partialMatch: false, pattern: "src/utils/**" },
      ],
    },
    rules: {
      "boundaries/dependencies": [
        "error",
        {
          default: "allow",
          policies: [
            {
              // utils/ is app- AND domain-blind: only other utils/ (+ external).
              from: { element: { type: "utils" } },
              disallow: {
                to: {
                  element: {
                    types: {
                      anyOf: [
                        "lib",
                        "app",
                        "components",
                        "db",
                        "auth",
                        "platform",
                        "entities",
                        "views",
                        "procedures",
                        "subagents-lib",
                        "subagents-registry",
                        "memory",
                        "scrape",
                        "widgets",
                        "agent-contracts",
                        "agent-tools",
                        "agent-tools-lib",
                        "agent-runtime",
                        "agent-hank",
                        "agent-session",
                        "agent-runtree",
                      ],
                    },
                  },
                },
              },
              message:
                "src/utils is app- and domain-blind — it may import only other utils/ modules (and external packages). Move an app-aware helper to src/lib; a server-only one to the owning layer.",
            },
            {
              // entities/ is a leaf: nothing above it may be imported back in.
              from: { element: { type: "entities" } },
              disallow: {
                to: {
                  element: {
                    types: {
                      anyOf: [
                        "views",
                        "procedures",
                        "subagents-lib",
                        "subagents-registry",
                        "widgets",
                        "agent-contracts",
                        "agent-tools",
                        "agent-tools-lib",
                        "agent-runtime",
                        "agent-hank",
                        "agent-session",
                        "agent-runtree",
                        "app",
                        "components",
                        "lib",
                      ],
                    },
                  },
                },
              },
              message:
                "entities/ is the bottom of the domain DAG (…→views→entities→platform). It may not import views/procedures/subagents/widgets/agent code — that's a back-edge. A read whose shape a screen dictates is a view; a step that calls an LLM is a procedure.",
            },
            {
              // views/ read payloads: below procedures, above entities. (subagents
              // and agent-contracts are allowed — a view may import a sub-agent's
              // output TYPE and the UiEvent vocabulary.)
              from: { element: { type: "views" } },
              disallow: {
                to: {
                  element: {
                    types: {
                      anyOf: [
                        "procedures",
                        "widgets",
                        "agent-tools",
                        "agent-tools-lib",
                        "agent-runtime",
                        "agent-hank",
                        "agent-session",
                        "agent-runtree",
                      ],
                    },
                  },
                },
              },
              message:
                "views/ is a read payload — it may import entities/ (+ platform), never procedures/widgets/agent machinery.",
            },
            {
              // platform/ is infra: it may not know any domain.
              from: { element: { type: "platform" } },
              disallow: {
                to: {
                  element: {
                    types: {
                      anyOf: [
                        "entities",
                        "views",
                        "procedures",
                        "subagents-lib",
                        "subagents-registry",
                        "memory",
                        "scrape",
                        "widgets",
                        "agent-contracts",
                        "agent-tools",
                        "agent-tools-lib",
                        "agent-runtime",
                        "agent-hank",
                        "agent-session",
                        "agent-runtree",
                      ],
                    },
                  },
                },
              },
              message:
                "platform/ is domain-blind infrastructure — it may not import entities/views/procedures/subagents/memory/scrape/widgets or agent code. A module that names a company/job/opportunity/contact belongs on the domain side.",
            },
            {
              // agent/runtime is domain-blind machinery. The ONE sanctioned
              // exception (runUserMessage → procedures/registry/chat, the handoff
              // itself) carries an inline disable at that import.
              from: { element: { type: "agent-runtime" } },
              disallow: {
                to: {
                  element: {
                    types: {
                      anyOf: [
                        "entities",
                        "views",
                        "procedures",
                        "memory",
                        "scrape",
                        "widgets",
                      ],
                    },
                  },
                },
              },
              message:
                "agent/runtime is domain-blind machinery — no imports from entities/views/procedures/memory/scrape/widgets. If you need domain here, the code belongs in procedures/registry/chat.",
            },
            {
              // A sub-agent DEF is LLM I/O only — no DB. (The run-capture that
              // does touch the DB lives in subagents/lib, not registry.)
              from: { element: { type: "subagents-registry" } },
              disallow: { to: { element: { type: "db" } } },
              message:
                "A sub-agent registry file holds LLM I/O only — no direct DB access. Persist in the caller (a procedure) after the sub-agent returns.",
            },
          ],
        },
      ],
    },
  },

  // MUST be last: turn off every rule Prettier already enforces, so ESLint and
  // Prettier never disagree about formatting.
  prettier,

  // Override default ignores of eslint-config-next.
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src/generated/**",
  ]),
]);

export default eslintConfig;
