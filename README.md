# @latch/node

Latch server SDK for Node.js: evaluates feature flags in-process from a synced ruleset.

[Latch](https://latch.inkress.com) is feature flags you can hand to the whole team.

## Install

The package isn't on npm yet. Install it from GitHub:

```sh
pnpm add github:inkress/latch-node
```

## Use

```ts
import { createClient } from "@latch/node";

const latch = createClient({ serverKey: process.env.LATCH_SERVER_KEY! });
await latch.waitForReady();

const on = await latch.boolVariation("new-checkout", { targetingKey: "user-42" }, false);
```

Flags are evaluated in your process from a ruleset the client keeps up to date, so a check makes no network call. See `examples/node-server`.

## The flag engine

`src/engine/` is a copy of Latch's flag engine, the same code Latch's servers and edge use, so answers match exactly. Don't edit it here. Run `pnpm sync-engine <path to the Latch monorepo>` to refresh it; the commit it came from is in `src/engine/SOURCE`.

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test
```

## License

MIT

## Typed flag keys (optional)

The SDK works with plain string keys. If you want your editor and build to catch a misspelt, renamed or removed flag, generate a types file from your project:

```sh
LATCH_API_TOKEN=lat_… npx github:inkress/latch-node latch-generate \
  --project <project key> --api <your Latch URL> --out src/latch-flags.generated.ts
```

The token needs the `flags:read` scope. The file holds `LatchFlag` (every key by a readable name, e.g. `LatchFlag.PerksHeroImage`), `LatchFlagKind`, `LatchFlagValues` (the value type of each flag, with the allowed values of string flags) and `LatchBooleanFlagKey`. Commit it, and run the command again after changing flags in Latch. `--check` exits 1 when the file is out of date, for CI.
