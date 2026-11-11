import type { ModelProfileView } from '@ensemus/contracts/ai';
import type { ReactNode } from 'react';
import { CAPABILITY_LABEL, CLASS_LABEL, PURPOSE_LABEL, RETENTION_LABEL } from './model-form';

function Choices({
  legend,
  help,
  name,
  labels,
  chosen,
}: {
  legend: string;
  help?: string;
  name: string;
  labels: Record<string, string>;
  chosen: readonly string[];
}) {
  return (
    <fieldset className="group">
      <legend>{legend}</legend>
      {help && <small className="muted">{help}</small>}
      <div className="option-grid">
        {Object.entries(labels).map(([value, label]) => (
          <label className="check" key={value}>
            <input
              type="checkbox"
              name={name}
              value={value}
              defaultChecked={chosen.includes(value)}
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * What a new profile and an edit have in common. `text` is how a text field is drawn, because a new
 * profile's fields keep what was typed across a refusal and an edit's start from the saved values.
 */
export function ProfileFields({
  profile,
  others,
  text,
}: {
  profile: ModelProfileView | null;
  others: readonly { id: string; alias: string }[];
  text: (field: {
    name: string;
    defaultValue: string;
    required?: boolean;
    maxLength: number;
    type?: string;
    inputMode?: 'numeric';
    placeholder?: string;
  }) => ReactNode;
}) {
  return (
    <>
      <label>
        Name people will see
        {text({
          name: 'alias',
          defaultValue: profile?.alias ?? '',
          required: true,
          maxLength: 80,
        })}
      </label>
      <label>
        Model name at the provider
        {text({
          name: 'modelId',
          defaultValue: profile?.model_id ?? '',
          required: true,
          maxLength: 200,
        })}
      </label>
      <label>
        Address
        {text({
          name: 'endpointUrl',
          defaultValue: profile?.endpoint_url ?? '',
          required: true,
          maxLength: 500,
          type: 'url',
        })}
        <small>
          Changing this removes the key and sends the model back to be tested, because a key is only
          ever good for the address it was given for.
        </small>
      </label>
      <label>
        Region (optional)
        {text({ name: 'region', defaultValue: profile?.region ?? '', maxLength: 64 })}
      </label>
      <section className="form-section" aria-labelledby="model-limits">
        <h3 id="model-limits">Limits</h3>
        <p className="muted">
          Measured in tokens, the pieces of text a model reads and writes. A token is roughly
          three-quarters of a word. The model’s own documentation gives these numbers.
        </p>
        <label>
          Longest input, in tokens
          {text({
            name: 'maxInputTokens',
            defaultValue: profile ? String(profile.limits.max_input_tokens) : '',
            required: true,
            maxLength: 10,
            inputMode: 'numeric',
          })}
        </label>
        <label>
          Longest answer, in tokens
          {text({
            name: 'maxOutputTokens',
            defaultValue: profile ? String(profile.limits.max_output_tokens) : '',
            required: true,
            maxLength: 10,
            inputMode: 'numeric',
          })}
        </label>
      </section>
      <section className="form-section" aria-labelledby="model-uses">
        <h3 id="model-uses">Uses and access</h3>
        <Choices
          legend="What it can do"
          name="capabilities"
          labels={CAPABILITY_LABEL}
          chosen={profile?.capabilities ?? ['text']}
        />
        <Choices
          legend="What it may be sent, by who can see it"
          help="Work marked with a level you leave clear is never sent to this model."
          name="allowedClasses"
          labels={CLASS_LABEL}
          chosen={profile?.allowed_classes ?? ['public']}
        />
        <Choices
          legend="What it may be used for"
          name="allowedPurposes"
          labels={PURPOSE_LABEL}
          chosen={profile?.allowed_purposes ?? []}
        />
      </section>
      <section className="form-section" aria-labelledby="model-terms">
        <h3 id="model-terms">How they keep your data</h3>
        <label>
          What is known about how they keep data
          <select name="retentionBasis" defaultValue={profile?.retention_basis ?? 'unreviewed'}>
            {Object.entries(RETENTION_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Where their terms are recorded (optional)
          {text({ name: 'contractRef', defaultValue: profile?.contract_ref ?? '', maxLength: 200 })}
          <small>Without this, confidential work is never sent to this model.</small>
        </label>
      </section>
      {others.length > 0 && (
        <section className="form-section" aria-labelledby="model-fallback">
          <h3 id="model-fallback">When it is unavailable</h3>
          <fieldset className="group">
            <legend>If this model is unavailable, try these (off unless you choose one)</legend>
            <div className="option-grid">
              {others.map((other) => (
                <label className="check" key={other.id}>
                  <input
                    type="checkbox"
                    name="fallback"
                    value={other.id}
                    defaultChecked={profile?.fallback_profile_ids.includes(other.id) ?? false}
                  />
                  {other.alias}
                </label>
              ))}
            </div>
          </fieldset>
        </section>
      )}
    </>
  );
}
