/**
 * Registry vs. account audit — `npm run models:check`.
 *
 * The registry declares what the pipeline intends to call. Whether those calls will
 * actually succeed is a property of the *account*: model access has to be granted, per
 * Region, by whoever administers Bedrock. Nothing in the repo can know that, and the
 * failure mode without this script is an image-generation AccessDeniedException in CloudWatch
 * after a deploy.
 *
 * So this asks the account directly, for every model in the registry:
 *
 *   - is the inference profile ACTIVE, and which Regions does it really fan out to
 *   - is the model AUTHORIZED and entitled, in *each* of those Regions
 *   - does the declared `residency` still match reality
 *
 * A global cross-Region profile is the exception: its Regions cannot be listed, so only its
 * entry Region is checked.
 *
 * A `litellm` or `openai` entry is not an AWS model at all: it is usable when the gateway, or
 * OpenAI, lists its id for the key this process holds.
 *
 * Read-only. Safe to run against any account, and the natural first command after
 * moving to a new one.
 */

import {
  BedrockClient,
  GetFoundationModelAvailabilityCommand,
  GetInferenceProfileCommand,
} from '@aws-sdk/client-bedrock';
import { litellmConfigFromEnv } from '../litellm/client.js';
import { openaiConfigFromEnv } from '../openai/client.js';
import { authHeaders, type OpenAICompatibleConfig } from '../openai/compatible.js';
import { allModels } from './index.js';
import { isGlobalProfile, unsupportedProvider, type ModelEntry } from './schema.js';

/** A `us.` / `eu.` / `apac.` / `global.` prefix means the id is a geo inference profile, not a model. */
const GEO_PREFIX = /^(us|eu|apac|global)\./;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** `arn:aws:bedrock:us-east-2::foundation-model/x` -> `us-east-2`. */
const regionOfArn = (arn: string) => arn.split(':')[3] ?? '';

const clients = new Map<string, BedrockClient>();
const client = (region: string) => {
  const existing = clients.get(region);
  if (existing) return existing;
  const created = new BedrockClient({ region });
  clients.set(region, created);
  return created;
};

interface RegionFinding {
  region: string;
  /** `undefined` when the availability call itself failed — reported, never swallowed. */
  authorized?: boolean;
  detail: string;
}

/**
 * eu-south-1, eu-south-2 and friends are opt-in Regions. If the account has not enabled
 * one, our credentials are simply not valid there and no Bedrock call can be made — which
 * says nothing about model access, so it must not be reported as a failure.
 *
 * It is worth printing all the same: Bedrock may still route a geo-profile request into
 * that Region, so it stays inside the residency footprint while being unverifiable here.
 */
function isRegionNotEnabled(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  return (
    name === 'UnrecognizedClientException' ||
    name === 'InvalidSignatureException' ||
    /security token included in the request is invalid/i.test(message(err))
  );
}

interface Finding {
  entry: ModelEntry;
  profileStatus?: string;
  /** Regions the live profile fans out to, when the id is a geo profile. */
  liveRegions?: string[];
  regions: RegionFinding[];
  problems: string[];
}

interface ProfileAudit {
  status?: string;
  liveRegions?: string[];
  problems: string[];
}

/** Asks the account what the geo profile behind `entry.bedrockModelId` actually is. */
async function auditInferenceProfile(entry: ModelEntry): Promise<ProfileAudit> {
  const problems: string[] = [];
  try {
    const profile = await client(entry.region).send(
      new GetInferenceProfileCommand({ inferenceProfileIdentifier: entry.bedrockModelId }),
    );
    const liveRegions = (profile.models ?? []).map((m) => regionOfArn(m.modelArn ?? ''));

    if (profile.status !== 'ACTIVE') {
      problems.push(`inference profile is ${profile.status}, not ACTIVE`);
    }

    const declared = [...entry.residency].sort().join(',');
    const live = [...liveRegions].sort().join(',');
    // A global profile's live list is not its footprint, so there is nothing to compare.
    if (!isGlobalProfile(entry) && declared !== live) {
      problems.push(`residency drift: registry says [${declared}], profile fans out to [${live}]`);
    }

    return { status: profile.status, liveRegions, problems };
  } catch (err) {
    problems.push(`inference profile unreadable in ${entry.region}: ${message(err)}`);
    return { problems };
  }
}

/** One Region's answer, plus the problem it implies for the entry, if any. */
async function auditRegion(
  region: string,
  baseModelId: string,
): Promise<{ finding: RegionFinding; problem?: string }> {
  try {
    const availability = await client(region).send(
      new GetFoundationModelAvailabilityCommand({ modelId: baseModelId }),
    );
    const authorized =
      availability.authorizationStatus === 'AUTHORIZED' &&
      availability.entitlementAvailability === 'AVAILABLE' &&
      availability.regionAvailability === 'AVAILABLE';

    const finding: RegionFinding = {
      region,
      authorized,
      detail: [
        `auth=${availability.authorizationStatus}`,
        `entitlement=${availability.entitlementAvailability}`,
        `region=${availability.regionAvailability}`,
        `agreement=${availability.agreementAvailability?.status}`,
      ].join(' '),
    };
    return { finding, problem: authorized ? undefined : `not usable in ${region}` };
  } catch (err) {
    if (isRegionNotEnabled(err)) {
      return { finding: { region, detail: 'opt-in Region not enabled — cannot verify' } };
    }
    return {
      finding: { region, detail: message(err) },
      problem: `availability unreadable in ${region}: ${message(err)}`,
    };
  }
}

/**
 * The gateway answers `GET /v1/models` with `{ data: [{ id }] }`; OpenAI is assumed to answer the
 * same, not verified against its reference. A shape mismatch shows as "not among the 0 models",
 * never as a false pass.
 */
async function auditListedModel(
  entry: ModelEntry,
  config: OpenAICompatibleConfig,
  who: { answerer: string; noun: string; key: string },
): Promise<Finding> {
  const finding: Finding = { entry, regions: [], problems: [] };
  try {
    const res = await config.fetch(`${config.baseUrl}/v1/models`, {
      headers: await authHeaders(config),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      finding.problems.push(`${who.answerer} answered ${res.status} to /v1/models`);
      return finding;
    }
    const body = (await res.json()) as { data?: { id?: string }[] };
    const ids = (body.data ?? []).map((m) => m.id);
    const listed = ids.includes(entry.bedrockModelId);
    finding.regions.push({
      region: entry.region,
      authorized: listed,
      detail: listed
        ? `${who.noun} listed for this key`
        : `${who.noun} not among the ${ids.length} models this key can call`,
    });
    if (!listed)
      finding.problems.push(`${entry.bedrockModelId} is not available to this ${who.key}`);
  } catch (err) {
    finding.problems.push(`${who.answerer} unreadable: ${message(err)}`);
  }
  return finding;
}

function auditLiteLLM(entry: ModelEntry): Promise<Finding> {
  return auditListedModel(entry, litellmConfigFromEnv(), {
    answerer: 'gateway',
    noun: 'alias',
    key: 'LiteLLM key',
  });
}

/** Asked at the entry's own host, so an EU entry is checked against the EU host. */
function auditOpenAI(entry: ModelEntry): Promise<Finding> {
  return auditListedModel(entry, openaiConfigFromEnv(entry), {
    answerer: 'OpenAI',
    noun: 'model',
    key: 'OpenAI key',
  });
}

function auditEntry(entry: ModelEntry): Promise<Finding> {
  switch (entry.provider) {
    case 'litellm':
      return auditLiteLLM(entry);
    case 'openai':
      return auditOpenAI(entry);
    case 'bedrock':
      return auditBedrock(entry);
    default:
      return unsupportedProvider(entry.id, entry.provider);
  }
}

async function auditBedrock(entry: ModelEntry): Promise<Finding> {
  // The bare model id, which is what the availability API takes: a geo profile is not a
  // foundation model and asking about one by its profile id gets nowhere.
  const baseModelId = entry.bedrockModelId.replace(GEO_PREFIX, '');

  const profile = GEO_PREFIX.test(entry.bedrockModelId)
    ? await auditInferenceProfile(entry)
    : undefined;

  const finding: Finding = {
    entry,
    profileStatus: profile?.status,
    liveRegions: profile?.liveRegions,
    regions: [],
    problems: [...(profile?.problems ?? [])],
  };

  // Access is granted per Region, and a geo profile can route to any member Region — so a
  // model authorized only in the entry Region will still fail, intermittently, in prod.
  const regions = isGlobalProfile(entry)
    ? [entry.region]
    : finding.liveRegions?.length
      ? finding.liveRegions
      : entry.residency;

  for (const region of regions) {
    const { finding: regionFinding, problem } = await auditRegion(region, baseModelId);
    finding.regions.push(regionFinding);
    if (problem) finding.problems.push(problem);
  }

  return finding;
}

function printFinding(f: Finding) {
  const ok = f.problems.length === 0;
  console.log(`${ok ? '✓' : '✗'} ${f.entry.id}  (${f.entry.category})`);
  console.log(`    ${f.entry.bedrockModelId}`);
  if (f.profileStatus) console.log(`    profile: ${f.profileStatus}`);
  for (const r of f.regions) {
    const mark = r.authorized === undefined ? '--  ' : r.authorized ? 'ok  ' : 'FAIL';
    console.log(`    ${mark} ${r.region}  ${r.detail}`);
  }
  for (const p of f.problems) console.log(`    ! ${p}`);
  console.log();
}

async function main() {
  const models = allModels();
  console.log(`Auditing ${models.length} registry models against the current account.\n`);

  // Sequential on purpose: a dozen models is a second of latency, and interleaved output
  // from parallel calls is harder to read than the audit is slow.
  const findings: Finding[] = [];
  for (const entry of models) {
    findings.push(await auditEntry(entry));
  }

  for (const f of findings) printFinding(f);

  const broken = findings.filter((f) => f.problems.length > 0);
  if (broken.length === 0) {
    console.log('All registry models are active and authorized in every Region they can route to.');
    return;
  }

  console.log(
    `${broken.length} model(s) need attention: ${broken.map((f) => f.entry.id).join(', ')}`,
  );
  console.log(
    'Grant access in the Bedrock console under Model access, in every Region listed above;',
  );
  console.log('for a LiteLLM model, ask the gateway owners to add the alias to the key;');
  console.log(
    'for an OpenAI model, check the project key (OPENAI_API_KEY or OPENAI_API_KEY_SECRET_ARN) can call it.',
  );
  // Non-zero so this can gate a deploy without anyone having to read the output.
  process.exitCode = 1;
}

await main();
