import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
/** Shared native form for both authority requests. Every spending ceiling is entered explicitly. */
export function ModelBoundsFields({ qualification = false }: { qualification?: boolean }) {
  return (
    <fieldset className="fields">
      <legend>Spending and execution limits</legend>
      <p className="muted">
        Limits apply to each job and remain subject to the organization budget and model policy. One
        US dollar is 1,000,000 micro-USD.
      </p>
      <Label>
        Maximum calls
        <Input
          name="maxCalls"
          type="number"
          required
          min="1"
          max="1000"
          {...(qualification ? { value: 1, readOnly: true } : {})}
        />
      </Label>
      <Label>
        Maximum input tokens per call
        <Input name="maxInputTokens" type="number" required min="1" max="2147483647" />
      </Label>
      <Label>
        Maximum output tokens per call
        <Input name="maxOutputTokens" type="number" required min="1" max="2147483647" />
      </Label>
      <Label>
        Maximum total tokens per job
        <Input name="maxTotalTokens" type="number" required min="1" max="9007199254740991" />
      </Label>
      <Label>
        Maximum cost per job (micro-USD)
        <Input name="maxCostMicros" type="number" required min="0" max="9007199254740991" />
      </Label>
      <Label>
        Time limit per job (seconds)
        <Input name="timeoutSeconds" type="number" required min="1" max="86400" />
      </Label>
    </fieldset>
  );
}
