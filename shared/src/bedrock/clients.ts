import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

/**
 * One client per Region, created on first use and reused for the container's life. The Region
 * comes from the registry entry, never from the call site.
 */
const clients = new Map<string, BedrockRuntimeClient>();

export function bedrockFor(region: string): BedrockRuntimeClient {
  const existing = clients.get(region);
  if (existing) return existing;

  const client = new BedrockRuntimeClient({
    region,
    // The durable step around each call has its own retry; more SDK attempts multiply spend.
    maxAttempts: 2,
  });

  clients.set(region, client);
  return client;
}
