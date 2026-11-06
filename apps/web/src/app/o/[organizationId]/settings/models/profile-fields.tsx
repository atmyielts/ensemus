import type { ModelProfileView } from '@ensemus/contracts/ai';
import type { ReactNode } from 'react';
import { CAPABILITY_LABEL, CLASS_LABEL, PURPOSE_LABEL, RETENTION_LABEL } from './model-form';

function Choices({
  legend,
  name,
  labels,
  chosen,
}: {
  legend: string;
  name: string;
  labels: Record<string, string>;
  chosen: readonly string[];
}) {
  return (
    <fieldset className="group">
      <legend>{legend}</legend>
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
      <Choices
        legend="What it can do"
        name="capabilities"
        labels={CAPABILITY_LABEL}
        chosen={profile?.capabilities ?? ['text']}
      />
      <Choices
        legend="Sensitivity of what it may be sent"
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
      {others.length > 0 && (
        <fieldset className="group">
          <legend>If this model is unavailable, try these (off unless you choose one)</legend>
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
        </fieldset>
      )}
    </>
  );
}
