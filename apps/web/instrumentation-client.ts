import { z } from 'zod';

// OpenTab intentionally ships a strict CSP without `unsafe-eval`. Configure
// Zod before application hydration so it neither probes nor emits JIT parsers
// through `Function` in browsers that report caught CSP violations.
z.config({ jitless: true });
