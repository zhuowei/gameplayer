Zero-dependency CDP + gameplay control CLI backed by `packages/runtime`.

```sh
# Rebuild runtime bundle
bun build --outfile=../runtime/gameplay-runtime.js --format=iife ../runtime/index.ts

# Check CLI usage (connects to Chrome launched with --remote-debugging-port=9222)
bun run index.ts help
bun run index.ts pages
bun run index.ts drive --ms 3000 --out /tmp/servo.jpg
```
