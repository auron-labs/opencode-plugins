import type { Model } from '@opencode-ai/sdk';
import type { OmniRouteProviderModel } from './src/types.js';

// Type compatibility test: OmniRouteProviderModel should be assignable to Model
const _testCompat = (m: OmniRouteProviderModel): Model => m;
