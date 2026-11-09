import type { ModelUse } from '@sketch-to-product-views/contracts';

/**
 * Names the model a stage actually called, read off the run (never the registry, whose default
 * changes on a swap). The provider model id is the tooltip.
 */
export function ModelTag({ model, role }: { model: ModelUse; role?: string }) {
  return (
    <p className="model-tag">
      {role ? <span className="model-tag-role">{role}</span> : null}
      <span className="chip chip--model" title={model.bedrockModelId}>
        {model.name}
      </span>
    </p>
  );
}
