// isomorphic-git expects Node's Buffer; must be evaluated before it loads.
import { Buffer } from 'buffer';

(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
